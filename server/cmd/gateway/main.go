package main

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/redis/go-redis/v9"

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

	// Redis-backed token blocklist for device revocation checks (required).
	if cfg.RedisURL == "" {
		slog.Error("MEZA_REDIS_URL is required for the gateway (device revocation)")
		os.Exit(1)
	}
	redisClient, err := bfredis.NewClient(ctx, cfg.RedisURL)
	if err != nil {
		slog.Error("connect redis", "err", err)
		os.Exit(1)
	}
	defer redisClient.Close()
	tokenBlocklist := auth.NewTokenBlocklist(redisClient)
	slog.Info("device revocation blocklist enabled")

	// Validate WebSocket origin configuration. Refuse to start with wildcard
	// origins unless explicitly opted in via MEZA_ALLOW_WILDCARD_ORIGINS=true.
	origins := parseAllowedOrigins(cfg.AllowedOrigins)
	for _, o := range origins {
		if o == "*" && !cfg.AllowWildcardOrigins {
			slog.Error("MEZA_ALLOWED_ORIGINS must not contain \"*\". Set explicit origins or set MEZA_ALLOW_WILDCARD_ORIGINS=true to override.")
			os.Exit(1)
		}
		if o != "*" && strings.Contains(o, "*") {
			slog.Warn("SECURITY: origin pattern contains wildcard glob -- this may be overly broad", "pattern", o)
		}
	}

	gw := NewGatewayWithOrigins(chatStore, readStateStore, messageStore, chatClient, nc, origins, tokenBlocklist)
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
	mux.HandleFunc("/healthz", healthHandler)
	mux.HandleFunc("/health", healthHandler) // backwards compat
	mux.HandleFunc("/readyz", readinessHandler(redisClient))
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

// readinessHandler checks that security-critical dependencies (Redis) are
// reachable. Used as a Kubernetes readiness probe — failure removes the pod
// from the load balancer but does not restart it (unlike liveness).
func readinessHandler(redisClient *redis.Client) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 50*time.Millisecond)
		defer cancel()

		if err := redisClient.Ping(ctx).Err(); err != nil {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusServiceUnavailable)
			json.NewEncoder(w).Encode(map[string]string{"status": "not ready", "redis": err.Error()})
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"status": "ready"})
	}
}
