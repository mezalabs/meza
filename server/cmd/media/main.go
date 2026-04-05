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
	"github.com/mezalabs/meza/gen/meza/v1/mezav1connect"
	"github.com/mezalabs/meza/internal/auth"
	"github.com/mezalabs/meza/internal/config"
	"github.com/mezalabs/meza/internal/database"
	"github.com/mezalabs/meza/internal/middleware"
	"github.com/mezalabs/meza/internal/observability"
	"github.com/mezalabs/meza/internal/ratelimit"
	bfredis "github.com/mezalabs/meza/internal/redis"
	"github.com/mezalabs/meza/internal/s3"
	"github.com/mezalabs/meza/internal/store"
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

	// Redis-backed token blocklist for device revocation checks (required).
	if cfg.RedisURL == "" {
		slog.Error("MEZA_REDIS_URL is required for the media service (device revocation)")
		os.Exit(1)
	}
	redisClient, err := bfredis.NewClient(ctx, cfg.RedisURL)
	if err != nil {
		slog.Error("connect redis", "err", err)
		os.Exit(1)
	}
	defer redisClient.Close()
	tokenBlocklist := auth.NewTokenBlocklist(redisClient)

	mediaStore := store.NewMediaStore(pool)
	permChk := store.NewChannelPermissionStore(pool)
	accessChk := store.NewMediaAccessStore(pool, permChk)
	svc := newMediaService(mediaStore, accessChk, s3Client, s3Public)

	// Start background cleanup of orphaned uploads.
	startCleanup(ctx, mediaStore, s3Client)

	// Rate limiters per IP — separate budgets for RPCs vs media redirects.
	// The redirect endpoint is a lightweight 302 so it can tolerate higher
	// throughput; channels with many images trigger dozens of thumbnail
	// requests when first scrolled into view.
	rpcLimiter := ratelimit.New(10, 20)
	redirectLimiter := ratelimit.New(30, 50)

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
		auth.WithTokenBlocklist(tokenBlocklist),
	}
	path, handler := mezav1connect.NewMediaServiceHandler(svc,
		connect.WithInterceptors(auth.NewConnectInterceptor(ed25519PubKey, interceptorOpts...)),
		connect.WithRecover(func(ctx context.Context, spec connect.Spec, _ http.Header, r any) error {
			slog.Error("panic in media handler", "procedure", spec.Procedure, "recover", fmt.Sprint(r))
			return connect.NewError(connect.CodeInternal, fmt.Errorf("internal error"))
		}),
	)
	mux.Handle(path, rpcLimiter.Wrap(handler))

	// Stable redirect endpoint for media URLs (requires authentication + device revocation check).
	authMiddleware := auth.RequireHTTPAuth(ed25519PubKey, auth.WithHTTPTokenBlocklist(tokenBlocklist))
	mux.Handle("/media/", redirectLimiter.Wrap(authMiddleware(mediaRedirectHandler(mediaStore, accessChk, s3Public))))

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
