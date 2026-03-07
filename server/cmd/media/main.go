package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"runtime"
	"strings"
	"syscall"
	"time"

	"connectrpc.com/connect"
	"github.com/meza-chat/meza/gen/meza/v1/mezav1connect"
	"github.com/meza-chat/meza/internal/auth"
	"github.com/meza-chat/meza/internal/config"
	"github.com/meza-chat/meza/internal/database"
	"github.com/meza-chat/meza/internal/middleware"
	"github.com/meza-chat/meza/internal/observability"
	"github.com/meza-chat/meza/internal/ratelimit"
	"github.com/meza-chat/meza/internal/s3"
	"github.com/meza-chat/meza/internal/store"
	"github.com/davidbyttow/govips/v2/vips"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	cfg := config.MustLoad()
	logger := observability.NewLogger(cfg.LogLevel)
	slog.SetDefault(logger)

	if cfg.S3Bucket == "" {
		slog.Error("MEZA_S3_BUCKET is required for the media service")
		os.Exit(1)
	}

	// Initialize libvips with explicit concurrency control.
	vips.Startup(&vips.Config{ConcurrencyLevel: runtime.NumCPU()})
	defer vips.Shutdown()

	pool, err := database.NewPostgresPool(ctx, cfg.PostgresURL)
	if err != nil {
		slog.Error("connect postgres", "err", err)
		os.Exit(1)
	}
	defer pool.Close()

	s3Client, err := s3.NewClient(cfg.S3Endpoint, cfg.S3AccessKey, cfg.S3SecretKey, cfg.S3Bucket, cfg.S3Region, cfg.S3UseSSL)
	if err != nil {
		slog.Error("create s3 client", "err", err)
		os.Exit(1)
	}

	// Ensure the bucket exists.
	if err := s3Client.EnsureBucket(ctx); err != nil {
		slog.Error("ensure bucket", "err", err)
		os.Exit(1)
	}

	// Set CORS on the bucket for browser uploads.
	corsOrigins := os.Getenv("S3_CORS_ORIGINS")
	if corsOrigins != "" {
		origins := strings.Split(corsOrigins, ",")
		if err := s3Client.SetCORS(ctx, origins); err != nil {
			// Non-fatal: MinIO doesn't implement the S3 CORS XML API, and
			// CORS may already be configured via env vars or other means.
			slog.Debug("set bucket CORS (not supported by MinIO)", "err", err)
		}
	} else {
		slog.Error("S3_CORS_ORIGINS not set — bucket CORS not configured; set this for production deployments")
	}

	// Create a public-facing S3 client for presigned URL generation.
	// When S3_PUBLIC_ENDPOINT is set, presigned URLs use that endpoint so
	// clients on other networks (e.g. phones on LAN) can reach MinIO.
	s3Public := s3Client
	if cfg.S3PublicEndpoint != "" {
		s3Public, err = s3Client.WithPublicEndpoint(cfg.S3PublicEndpoint, cfg.S3UseSSL)
		if err != nil {
			slog.Error("create public s3 client", "err", err)
			os.Exit(1)
		}
		slog.Info("using public S3 endpoint for presigned URLs", "endpoint", cfg.S3PublicEndpoint)
	}

	mediaStore := store.NewMediaStore(pool)
	permChk := store.NewChannelPermissionStore(pool)
	accessChk := store.NewMediaAccessStore(pool, permChk)
	svc := newMediaService(mediaStore, accessChk, s3Client, s3Public)

	// Start background cleanup of orphaned uploads.
	startCleanup(ctx, mediaStore, s3Client)

	// Rate limit: 5 req/s burst 10 per IP.
	limiter := ratelimit.New(5, 10)

	mux := http.NewServeMux()

	// Load Ed25519 public key (required for JWT verification).
	ed25519PubKey, err := auth.LoadEd25519PublicKey(cfg.Ed25519PublicKey, cfg.Ed25519PublicKeyFile)
	if err != nil || ed25519PubKey == nil {
		slog.Error("Ed25519 public key is required", "err", err)
		os.Exit(1)
	}
	slog.Info("Ed25519 token verification enabled for media service")

	// All media RPCs require authentication. WithRecover catches CGO panics
	// from govips so a malformed image doesn't crash the process.
	authStore := store.NewAuthStore(pool)
	interceptorOpts := []auth.InterceptorOption{
		auth.WithUserExistenceCheck(authStore),
		auth.WithVerificationCache(auth.NewVerificationCache()),
	}
	path, handler := mezav1connect.NewMediaServiceHandler(svc,
		connect.WithInterceptors(auth.NewConnectInterceptor(ed25519PubKey, interceptorOpts...)),
		connect.WithRecover(func(ctx context.Context, spec connect.Spec, _ http.Header, r any) error {
			slog.Error("panic in media handler", "procedure", spec.Procedure, "recover", fmt.Sprint(r))
			return connect.NewError(connect.CodeInternal, fmt.Errorf("internal error"))
		}),
	)
	mux.Handle(path, limiter.Wrap(handler))

	// Stable redirect endpoint for media URLs (requires authentication).
	authMiddleware := auth.RequireHTTPAuth(ed25519PubKey)
	mux.Handle("/media/", limiter.Wrap(authMiddleware(mediaRedirectHandler(mediaStore, accessChk, s3Public))))

	mux.HandleFunc("/health", healthHandler)
	mux.Handle("/metrics", observability.MetricsHandler())

	// Enable h2c for gRPC protocol support.
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

	slog.Info("media service listening", "addr", cfg.ListenAddr)
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
