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

	"connectrpc.com/connect"
	"github.com/meza-chat/meza/gen/meza/v1/mezav1connect"
	"github.com/meza-chat/meza/internal/auth"
	"github.com/meza-chat/meza/internal/config"
	"github.com/meza-chat/meza/internal/database"
	"github.com/meza-chat/meza/internal/middleware"
	bfnats "github.com/meza-chat/meza/internal/nats"
	"github.com/meza-chat/meza/internal/observability"
	bfredis "github.com/meza-chat/meza/internal/redis"
	"github.com/meza-chat/meza/internal/store"
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

	rdb, err := bfredis.NewClient(ctx, cfg.RedisURL)
	if err != nil {
		slog.Error("connect redis", "err", err)
		os.Exit(1)
	}
	defer rdb.Close()

	nc, err := bfnats.NewClient(cfg.NatsURL)
	if err != nil {
		slog.Error("connect nats", "err", err)
		os.Exit(1)
	}
	defer nc.Drain()

	chatStore := store.NewChatStore(pool)
	svc := newPresenceService(rdb, nc, chatStore)

	// Start NATS heartbeat consumer
	sub, err := svc.StartHeartbeatConsumer()
	if err != nil {
		slog.Error("start heartbeat consumer", "err", err)
		os.Exit(1)
	}
	defer sub.Unsubscribe()

	authStore := store.NewAuthStore(pool)

	// Build interceptor options: user existence check + optional Ed25519 dual validation
	interceptorOpts := []auth.InterceptorOption{auth.WithUserExistenceCheck(authStore)}

	// Load Ed25519 public key (required for JWT verification).
	ed25519PubKey, err := auth.LoadEd25519PublicKey(cfg.Ed25519PublicKey, cfg.Ed25519PublicKeyFile)
	if err != nil || ed25519PubKey == nil {
		slog.Error("Ed25519 public key is required", "err", err)
		os.Exit(1)
	}
	interceptorOpts = append(interceptorOpts, auth.WithVerificationCache(auth.NewVerificationCache()))
	slog.Info("Ed25519 token verification enabled for presence service")

	interceptor := connect.WithInterceptors(auth.NewConnectInterceptor(ed25519PubKey, interceptorOpts...))

	mux := http.NewServeMux()
	path, handler := mezav1connect.NewPresenceServiceHandler(svc, interceptor)
	mux.Handle(path, handler)

	mux.HandleFunc("/health", healthHandler)
	mux.Handle("/metrics", observability.MetricsHandler())

	p := new(http.Protocols)
	p.SetHTTP1(true)
	p.SetUnencryptedHTTP2(true)

	srv := &http.Server{
		Addr:              cfg.ListenAddr,
		Handler:           middleware.SecurityHeaders(mux),
		Protocols:         p,
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	go func() {
		<-ctx.Done()
		slog.Info("shutdown signal received, draining connections")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if err := srv.Shutdown(shutdownCtx); err != nil {
			slog.Error("server shutdown error", "err", err)
		}
	}()

	slog.Info("presence service listening", "addr", cfg.ListenAddr)
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
