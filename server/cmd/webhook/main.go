package main

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/nats-io/nats.go"
	"google.golang.org/protobuf/proto"

	v1 "github.com/mezalabs/meza/gen/meza/v1"
	"github.com/mezalabs/meza/internal/config"
	"github.com/mezalabs/meza/internal/database"
	"github.com/mezalabs/meza/internal/models"
	bfnats "github.com/mezalabs/meza/internal/nats"
	"github.com/mezalabs/meza/internal/observability"
	"github.com/mezalabs/meza/internal/store"
	"github.com/mezalabs/meza/internal/subjects"
)

const (
	webhookHTTPTimeout  = 5 * time.Second
	webhookReloadSubject = "meza.internal.webhook.reload"
)

type webhookService struct {
	botStore   store.BotStorer
	nc         *nats.Conn
	httpClient *http.Client

	mu       sync.RWMutex
	// serverWebhooks maps serverID -> list of webhooks for that server.
	serverWebhooks map[string][]*models.BotWebhook
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	cfg := config.MustLoad()
	logger := observability.NewLogger(cfg.LogLevel)
	slog.SetDefault(logger)

	pool, err := database.NewPostgresPool(ctx, cfg.PostgresURL)
	if err != nil {
		slog.Error("connect postgres", "err", err)
		os.Exit(1)
	}
	defer pool.Close()

	nc, err := bfnats.NewClient(cfg.NatsURL)
	if err != nil {
		slog.Error("connect nats", "err", err)
		os.Exit(1)
	}
	defer nc.Drain()

	botStore := store.NewBotStore(pool)

	svc := &webhookService{
		botStore: botStore,
		nc:       nc,
		httpClient: &http.Client{
			Timeout: webhookHTTPTimeout,
			Transport: &http.Transport{
				MaxIdleConns:        100,
				MaxIdleConnsPerHost: 10,
				IdleConnTimeout:     90 * time.Second,
			},
		},
		serverWebhooks: make(map[string][]*models.BotWebhook),
	}

	// Initial load of all webhooks.
	if err := svc.loadAllWebhooks(ctx); err != nil {
		slog.Error("loading webhooks", "err", err)
		os.Exit(1)
	}

	// Subscribe to channel delivery events.
	deliverSub, err := nc.Subscribe(subjects.DeliverChannelWildcard(), svc.handleDelivery)
	if err != nil {
		slog.Error("subscribe channel delivery", "err", err)
		os.Exit(1)
	}
	defer deliverSub.Drain()

	// Subscribe to reload signals.
	reloadSub, err := nc.Subscribe(webhookReloadSubject, func(msg *nats.Msg) {
		slog.Info("reloading webhooks")
		if err := svc.loadAllWebhooks(context.Background()); err != nil {
			slog.Error("reloading webhooks", "err", err)
		}
	})
	if err != nil {
		slog.Error("subscribe webhook reload", "err", err)
		os.Exit(1)
	}
	defer reloadSub.Drain()

	slog.Info("webhook service started", "port", 8087)

	// Health endpoint.
	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("ok"))
	})

	server := &http.Server{
		Addr:    ":8087",
		Handler: mux,
	}

	go func() {
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			slog.Error("http server error", "err", err)
		}
	}()

	<-ctx.Done()
	slog.Info("shutting down webhook service")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	server.Shutdown(shutdownCtx)
}

func (svc *webhookService) loadAllWebhooks(ctx context.Context) error {
	// Query all webhooks by iterating servers with webhooks.
	// For simplicity, we reload from the bot_webhooks table directly.
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	rows, err := svc.botStore.(*store.BotStore).Pool().Query(ctx,
		`SELECT id, bot_user_id, server_id, url, secret, created_at FROM bot_webhooks`)
	if err != nil {
		return fmt.Errorf("query all webhooks: %w", err)
	}
	defer rows.Close()

	webhooks := make(map[string][]*models.BotWebhook)
	for rows.Next() {
		var w models.BotWebhook
		if err := rows.Scan(&w.ID, &w.BotUserID, &w.ServerID, &w.URL, &w.Secret, &w.CreatedAt); err != nil {
			return fmt.Errorf("scan webhook: %w", err)
		}
		webhooks[w.ServerID] = append(webhooks[w.ServerID], &w)
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("iterate webhooks: %w", err)
	}

	svc.mu.Lock()
	svc.serverWebhooks = webhooks
	svc.mu.Unlock()

	total := 0
	for _, wl := range webhooks {
		total += len(wl)
	}
	slog.Info("loaded webhooks", "count", total, "servers", len(webhooks))
	return nil
}

func (svc *webhookService) handleDelivery(msg *nats.Msg) {
	// Extract channel ID from subject: meza.deliver.channel.<channelID>
	parts := strings.Split(msg.Subject, ".")
	if len(parts) < 4 {
		return
	}

	// Parse the event to get server info.
	var event v1.Event
	if err := proto.Unmarshal(msg.Data, &event); err != nil {
		return
	}

	// Determine server ID from the event.
	serverID := extractServerID(&event)
	if serverID == "" {
		return
	}

	svc.mu.RLock()
	webhooks := svc.serverWebhooks[serverID]
	svc.mu.RUnlock()

	if len(webhooks) == 0 {
		return
	}

	// Build JSON payload.
	channelID := parts[3]
	payload := buildWebhookPayload(&event, serverID, channelID)
	if payload == nil {
		return
	}

	payloadBytes, err := json.Marshal(payload)
	if err != nil {
		slog.Error("marshal webhook payload", "err", err)
		return
	}

	// Deliver to all webhooks for this server (best-effort).
	for _, webhook := range webhooks {
		go svc.deliver(webhook, payloadBytes, event.Type.String())
	}
}

func (svc *webhookService) deliver(webhook *models.BotWebhook, body []byte, eventType string) {
	// Compute HMAC-SHA256 signature.
	mac := hmac.New(sha256.New, webhook.Secret)
	mac.Write(body)
	signature := hex.EncodeToString(mac.Sum(nil))

	req, err := http.NewRequest("POST", webhook.URL, strings.NewReader(string(body)))
	if err != nil {
		slog.Warn("build webhook request", "err", err, "webhook", webhook.ID)
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Meza-Signature", signature)
	req.Header.Set("X-Meza-Event", eventType)
	req.Header.Set("X-Meza-Delivery-ID", fmt.Sprintf("%d", time.Now().UnixNano()))

	resp, err := svc.httpClient.Do(req)
	if err != nil {
		slog.Warn("webhook delivery failed", "err", err, "webhook", webhook.ID, "url", webhook.URL)
		return
	}
	resp.Body.Close()

	if resp.StatusCode >= 400 {
		slog.Warn("webhook non-OK response", "status", resp.StatusCode, "webhook", webhook.ID, "url", webhook.URL)
	}
}

type webhookPayload struct {
	EventType string      `json:"event_type"`
	ServerID  string      `json:"server_id"`
	ChannelID string      `json:"channel_id"`
	Data      interface{} `json:"data"`
}

func buildWebhookPayload(event *v1.Event, serverID, channelID string) *webhookPayload {
	return &webhookPayload{
		EventType: event.Type.String(),
		ServerID:  serverID,
		ChannelID: channelID,
		Data:      event.Payload,
	}
}

func extractServerID(event *v1.Event) string {
	switch p := event.Payload.(type) {
	case *v1.Event_MessageCreate:
		return "" // Messages don't have server_id directly; we rely on the channel lookup.
	case *v1.Event_MemberJoin:
		return p.MemberJoin.ServerId
	case *v1.Event_MemberRemove:
		return p.MemberRemove.ServerId
	case *v1.Event_MemberUpdate:
		return p.MemberUpdate.ServerId
	case *v1.Event_RoleCreate:
		return p.RoleCreate.ServerId
	case *v1.Event_RoleUpdate:
		return p.RoleUpdate.ServerId
	case *v1.Event_RoleDelete:
		return p.RoleDelete.ServerId
	case *v1.Event_ChannelCreate:
		return p.ChannelCreate.ServerId
	case *v1.Event_ChannelUpdate:
		return p.ChannelUpdate.ServerId
	default:
		return ""
	}
}
