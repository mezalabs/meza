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
	"github.com/meza-chat/meza/internal/ratelimit"
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

	nc, err := bfnats.NewClient(cfg.NatsURL)
	if err != nil {
		slog.Error("connect nats", "err", err)
		os.Exit(1)
	}
	defer nc.Drain()

	keyEnvelopeStore := store.NewKeyEnvelopeStore(pool)
	permStore := store.NewChannelPermissionStore(pool)
	chatStore := store.NewChatStore(pool)
	svc := newKeyService(keyEnvelopeStore, permStore, chatStore, nc)

	// Load Ed25519 public key (required for JWT verification).
	ed25519PubKey, err := auth.LoadEd25519PublicKey(cfg.Ed25519PublicKey, cfg.Ed25519PublicKeyFile)
	if err != nil || ed25519PubKey == nil {
		slog.Error("Ed25519 public key is required", "err", err)
		os.Exit(1)
	}
	slog.Info("Ed25519 token verification enabled for keys service")

	interceptor := connect.WithInterceptors(auth.NewConnectInterceptor(ed25519PubKey,
		auth.WithVerificationCache(auth.NewVerificationCache()),
	))

	// Rate limit: 20 req/s burst 40 per IP for key endpoints
	keysLimiter := ratelimit.New(20, 40)

	mux := http.NewServeMux()
	path, handler := mezav1connect.NewKeyServiceHandler(svc, interceptor)
	mux.Handle(path, keysLimiter.Wrap(handler))

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

	slog.Info("keys service listening", "addr", cfg.ListenAddr)
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
