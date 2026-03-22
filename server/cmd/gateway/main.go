package main

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/mezalabs/meza/gen/meza/v1/mezav1connect"
	"github.com/mezalabs/meza/internal/auth"
	"github.com/mezalabs/meza/internal/config"
	"github.com/mezalabs/meza/internal/database"
	"github.com/mezalabs/meza/internal/middleware"
	bfnats "github.com/mezalabs/meza/internal/nats"
	"github.com/mezalabs/meza/internal/observability"
	"github.com/mezalabs/meza/internal/ratelimit"
	bfredis "github.com/mezalabs/meza/internal/redis"
	"github.com/mezalabs/meza/internal/store"
)

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

	scyllaSession, err := database.NewScyllaSession(cfg.ScyllaHosts, "meza")
	if err != nil {
		slog.Error("connect scylla", "err", err)
		os.Exit(1)
	}
	defer scyllaSession.Close()

	chatStore := store.NewChatStore(pool)
	readStateStore := store.NewReadStateStore(pool)
	messageStore := store.NewMessageStore(scyllaSession)

	// ConnectRPC client to chat service for SendMessage forwarding
	httpClient := &http.Client{
		Timeout: 10 * time.Second,
		Transport: &http.Transport{
			MaxIdleConns:        100,
			MaxIdleConnsPerHost: 10,
			IdleConnTimeout:     90 * time.Second,
		},
	}
	chatClient := mezav1connect.NewChatServiceClient(
		httpClient,
		cfg.ChatServiceURL,
	)

	// Load Ed25519 keys (required for JWT signing/verification)
	ed25519Keys, err := auth.LoadEd25519Keys(cfg.JWTPrivateKey, cfg.JWTPrivateKeyFile, cfg.JWTKeyID)
	if err != nil {
		slog.Error("Ed25519 private key is required", "err", err)
		os.Exit(1)
	}
	slog.Info("Ed25519 signing enabled", "kid", ed25519Keys.KeyID, "fingerprint", ed25519Keys.KeyFingerprint())

	// Redis-backed token blocklist for device revocation checks.
	// Optional: if REDIS_URL is not configured, revocation checks are skipped.
	var tokenBlocklist *auth.TokenBlocklist
	if cfg.RedisURL != "" {
		redisClient, err := bfredis.NewClient(ctx, cfg.RedisURL)
		if err != nil {
			slog.Error("connect redis", "err", err)
			os.Exit(1)
		}
		defer redisClient.Close()
		tokenBlocklist = auth.NewTokenBlocklist(redisClient)
		slog.Info("device revocation blocklist enabled")
	} else {
		slog.Warn("SECURITY: MEZA_REDIS_URL is not set -- device revocation checks are disabled on WebSocket auth")
	}

	// Bot token authentication for WebSocket connections.
	botStore := store.NewBotStore(pool)
	botTokenAuth := auth.NewTokenAuthenticator(botStore, auth.NewVerificationCache())

	// Subscribe to bot token revocation signals for cache invalidation.
	botRevokeSub, err := botTokenAuth.SubscribeRevocations(nc)
	if err != nil {
		slog.Error("subscribe bot token revocations", "err", err)
		os.Exit(1)
	}
	defer botRevokeSub.Drain()

	gw := NewGateway(chatStore, readStateStore, messageStore, chatClient, nc, cfg.AllowedOrigins, tokenBlocklist, botTokenAuth)
	gw.ed25519Keys = ed25519Keys
	gw.instanceURL = cfg.InstanceURL
	gw.verificationCache = auth.NewVerificationCache()

	if err := gw.Start(ctx); err != nil {
		slog.Error("start gateway", "err", err)
		os.Exit(1)
	}

	// Rate limit: 10 req/s burst 3 per IP for WebSocket connections
	wsLimiter := ratelimit.New(10, 3)

	mux := http.NewServeMux()
	mux.Handle("/ws", wsLimiter.Wrap(http.HandlerFunc(gw.HandleWebSocket)))
	mux.HandleFunc("/health", healthHandler)
	mux.Handle("/metrics", observability.MetricsHandler())

	srv := &http.Server{
		Addr:              cfg.ListenAddr,
		Handler:           middleware.SecurityHeaders(mux),
		ReadHeaderTimeout: 5 * time.Second,
		// DO NOT set ReadTimeout or WriteTimeout — they kill WebSocket connections
		IdleTimeout: 120 * time.Second,
	}

	go func() {
		<-ctx.Done()
		slog.Info("shutdown signal received, draining connections")

		// Send close frames to all WebSocket clients so they reconnect to another pod.
		gw.CloseAllConnections()

		shutdownCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if err := srv.Shutdown(shutdownCtx); err != nil {
			slog.Error("server shutdown error", "err", err)
		}
	}()

	slog.Info("gateway listening", "addr", cfg.ListenAddr)
	if err := srv.ListenAndServe(); err != http.ErrServerClosed {
		slog.Error("listen error", "err", err)
		os.Exit(1)
	}

	slog.Info("server stopped gracefully")
}

func healthHandler(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}
