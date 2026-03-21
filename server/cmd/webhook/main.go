package main

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"net"
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
	webhookHTTPTimeout    = 5 * time.Second
	maxConcurrentDelivery = 500 // bounded goroutine pool for webhook delivery
)

type webhookService struct {
	botStore   store.BotStorer
	nc         *nats.Conn
	httpClient *http.Client
	deliverSem chan struct{} // semaphore to bound concurrent HTTP deliveries

	mu             sync.RWMutex
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
		botStore:   botStore,
		nc:         nc,
		deliverSem: make(chan struct{}, maxConcurrentDelivery),
		httpClient: &http.Client{
			Timeout: webhookHTTPTimeout,
			Transport: &http.Transport{
				MaxIdleConns:        100,
				MaxIdleConnsPerHost: 10,
				IdleConnTimeout:     90 * time.Second,
				// SSRF protection: reject connections to private/internal IPs.
				DialContext: safeDialContext,
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

	// Subscribe to reload signals (use canonical subject from subjects package).
	reloadSub, err := nc.Subscribe(subjects.InternalWebhookReload(), func(msg *nats.Msg) {
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

// safeDialContext rejects connections to private, loopback, and link-local IPs
// to prevent SSRF attacks via webhook URLs.
func safeDialContext(ctx context.Context, network, addr string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, fmt.Errorf("invalid address: %w", err)
	}

	// Resolve the hostname to IPs.
	ips, err := net.DefaultResolver.LookupIPAddr(ctx, host)
	if err != nil {
		return nil, fmt.Errorf("dns lookup failed: %w", err)
	}

	for _, ip := range ips {
		if isPrivateIP(ip.IP) {
			return nil, fmt.Errorf("webhook URL resolves to private IP %s (blocked)", ip.IP)
		}
	}

	// Connect to the first allowed IP.
	dialer := &net.Dialer{Timeout: 5 * time.Second}
	return dialer.DialContext(ctx, network, net.JoinHostPort(ips[0].IP.String(), port))
}

// isPrivateIP returns true for loopback, private (RFC1918/RFC4193), link-local,
// and cloud metadata IP ranges.
func isPrivateIP(ip net.IP) bool {
	if ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsUnspecified() {
		return true
	}
	// AWS/GCP/Azure metadata endpoint: 169.254.169.254
	if ip.Equal(net.ParseIP("169.254.169.254")) {
		return true
	}
	return false
}

func (svc *webhookService) loadAllWebhooks(ctx context.Context) error {
	webhookList, err := svc.botStore.ListAllWebhooks(ctx)
	if err != nil {
		return fmt.Errorf("list all webhooks: %w", err)
	}

	webhooks := make(map[string][]*models.BotWebhook)
	for _, w := range webhookList {
		webhooks[w.ServerID] = append(webhooks[w.ServerID], w)
	}

	svc.mu.Lock()
	svc.serverWebhooks = webhooks
	svc.mu.Unlock()

	slog.Info("loaded webhooks", "count", len(webhookList), "servers", len(webhooks))
	return nil
}

func (svc *webhookService) handleDelivery(msg *nats.Msg) {
	// Extract channel ID from subject: meza.deliver.channel.<channelID>
	parts := strings.Split(msg.Subject, ".")
	if len(parts) < 4 {
		return
	}
	channelID := parts[3]

	// Quick check: are there any webhooks at all? Skip deserialization if not.
	svc.mu.RLock()
	hasAny := len(svc.serverWebhooks) > 0
	svc.mu.RUnlock()
	if !hasAny {
		return
	}

	// Parse the event.
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
	payload := buildWebhookPayload(&event, serverID, channelID)
	if payload == nil {
		return
	}

	payloadBytes, err := json.Marshal(payload)
	if err != nil {
		slog.Error("marshal webhook payload", "err", err)
		return
	}

	// Deliver to all webhooks for this server with bounded concurrency.
	for _, webhook := range webhooks {
		wh := webhook
		svc.deliverSem <- struct{}{} // backpressure
		go func() {
			defer func() { <-svc.deliverSem }()
			svc.deliver(wh, payloadBytes, event.Type.String())
		}()
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
		// Message events and other types without an embedded server_id are
		// skipped for now. Message delivery requires a channel-to-server lookup
		// cache which will be added in a follow-up.
		return ""
	}
}
