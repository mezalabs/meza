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
	"github.com/mezalabs/meza/gen/meza/v1/mezav1connect"
	"github.com/mezalabs/meza/internal/auth"
	"github.com/mezalabs/meza/internal/config"
	"github.com/mezalabs/meza/internal/database"
	"github.com/mezalabs/meza/internal/email"
	"github.com/mezalabs/meza/internal/federation"
	"github.com/mezalabs/meza/internal/middleware"
	bfnats "github.com/mezalabs/meza/internal/nats"
	"github.com/mezalabs/meza/internal/observability"
	"github.com/mezalabs/meza/internal/ratelimit"
	mezaRedis "github.com/mezalabs/meza/internal/redis"
	"github.com/mezalabs/meza/internal/store"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	cfg := config.MustLoad()
	logger := observability.NewLogger(cfg.LogLevel)
	slog.SetDefault(logger)

	// H-3: Validate HMAC secret at startup to ensure anti-enumeration
	// protections (fake salts / recovery bundles) are not defeated.
	if cfg.HMACSecret == "" {
		slog.Error("MEZA_HMAC_SECRET is required")
		os.Exit(1)
	}
	if len(cfg.HMACSecret) < 32 {
		slog.Error("MEZA_HMAC_SECRET must be at least 32 characters")
		os.Exit(1)
	}
	if cfg.HMACSecret == "dev-secret-change-in-production" {
		slog.Error("MEZA_HMAC_SECRET must be changed from the default value")
		os.Exit(1)
	}
	if cfg.HMACSecret == "meza-local-dev-hmac-secret-do-not-use-in-prod" {
		slog.Error("MEZA_HMAC_SECRET must be changed from the default value")
		os.Exit(1)
	}

	pool, err := database.NewPostgresPool(ctx, cfg.PostgresURL)
	if err != nil {
		slog.Error("connect postgres", "err", err)
		os.Exit(1)
	}
	defer pool.Close()

	// Load Ed25519 keys (required for JWT signing)
	ed25519Keys, err := auth.LoadEd25519Keys(cfg.JWTPrivateKey, cfg.JWTPrivateKeyFile, cfg.JWTKeyID)
	if err != nil {
		slog.Error("Ed25519 private key is required", "err", err)
		os.Exit(1)
	}
	slog.Info("Ed25519 signing enabled", "kid", ed25519Keys.KeyID, "fingerprint", ed25519Keys.KeyFingerprint())

	authStore := store.NewAuthStore(pool)
	chatStore := store.NewChatStore(pool)
	friendStore := store.NewFriendStore(pool)
	deviceStore := store.NewDeviceStore(pool)
	inviteStore := store.NewInviteStore(pool)
	federationStore := store.NewFederationStore(pool)
	svc := newAuthService(authStore, deviceStore, cfg.HMACSecret, ed25519Keys)
	svc.chatStore = chatStore
	svc.friendStore = friendStore
	svc.instanceURL = cfg.InstanceURL
	svc.registrationDisabled = cfg.RegistrationDisabled
	if cfg.RegistrationDisabled {
		slog.Info("local user registration is disabled")
	}

	// Connect Redis for per-email recovery rate limiting and device blocklist.
	if cfg.RedisURL != "" {
		rdb, err := mezaRedis.NewClient(ctx, cfg.RedisURL)
		if err != nil {
			slog.Error("connect redis", "err", err)
			os.Exit(1)
		}
		defer rdb.Close()
		svc.redisClient = rdb
		svc.tokenBlocklist = auth.NewTokenBlocklist(rdb)
	}

	// Connect NATS for publishing device recovery events.
	nc, err := bfnats.NewClient(cfg.NatsURL)
	if err != nil {
		slog.Error("connect nats", "err", err)
		os.Exit(1)
	}
	defer nc.Drain()
	svc.nc = nc

	// Email sender for OTP verification.
	if cfg.SMTPHost != "" {
		svc.emailSender = email.NewSMTPSender(cfg.SMTPHost, cfg.SMTPPort, cfg.SMTPFrom, cfg.SMTPUsername, cfg.SMTPPassword)
	} else {
		svc.emailSender = email.NewNoopSender()
		slog.Warn("SMTP not configured, using noop email sender")
	}

	// Build interceptor options: verification cache + optional token blocklist
	baseOpts := []auth.InterceptorOption{
		auth.WithVerificationCache(auth.NewVerificationCache()),
	}
	if svc.tokenBlocklist != nil {
		baseOpts = append(baseOpts, auth.WithTokenBlocklist(svc.tokenBlocklist))
	}

	// Auth service interceptor blocks federated users from identity RPCs
	// (password change, key bundle, device management, profile updates).
	authInterceptorOpts := append([]auth.InterceptorOption{}, baseOpts...)
	authInterceptorOpts = append(authInterceptorOpts, auth.WithBlockFederated())

	// Rate limit: 5 req/s burst 10 per IP for auth endpoints
	authLimiter := ratelimit.New(5, 10)

	mux := http.NewServeMux()

	// Most auth routes are public (Register, Login, GetSalt).
	// Profile/device/key RPCs require a JWT, so we use the optional interceptor.
	// Federated users are blocked from identity RPCs via WithBlockFederated.
	path, handler := mezav1connect.NewAuthServiceHandler(svc,
		connect.WithInterceptors(auth.NewOptionalConnectInterceptor(ed25519Keys.PublicKey, authInterceptorOpts...)),
	)
	mux.Handle(path, authLimiter.Wrap(handler))

	// Federation service
	banStore := store.NewBanStore(pool)
	fedSvc := &federationService{
		authStore:       authStore,
		federationStore: federationStore,
		chatStore:       chatStore,
		inviteStore:     inviteStore,
		banStore:        banStore,
		ed25519Keys:     ed25519Keys,
		instanceURL:     cfg.InstanceURL,
		redisClient:     svc.redisClient, // Shared Redis for jti replay protection
	}

	// Set up federation verifier if federation is enabled
	if cfg.FederationEnabled && ed25519Keys != nil {
		if svc.redisClient == nil {
			slog.Error("Redis is required when federation is enabled (for JTI replay protection)")
			os.Exit(1)
		}
		jwksClient := federation.NewJWKSClient()
		if err := jwksClient.EagerLoad(ctx, cfg.OriginURL); err != nil {
			slog.Error("eager loading JWKS", "err", err)
			os.Exit(1)
		}
		jwksClient.StartBackgroundRefresh(ctx, cfg.OriginURL)
		fedSvc.verifier = federation.NewVerifier(jwksClient, cfg.InstanceURL, cfg.OriginURL)
	}

	// Federation endpoints use the optional interceptor WITHOUT federation blocking
	// (join/refresh/leave are meant for federated users). Rate limited separately.
	fedPath, fedHandler := mezav1connect.NewFederationServiceHandler(fedSvc,
		connect.WithInterceptors(auth.NewOptionalConnectInterceptor(ed25519Keys.PublicKey, baseOpts...)),
	)
	fedLimiter := ratelimit.New(3, 5) // Tighter limits for federation endpoints
	mux.Handle(fedPath, federationCORS(fedLimiter.Wrap(fedHandler)))

	// JWKS endpoint for federation key discovery
	if ed25519Keys != nil {
		mux.HandleFunc("/.well-known/jwks.json", auth.NewJWKSHandler(ed25519Keys.PublicKey, ed25519Keys.KeyID))
	}

	mux.HandleFunc("/health", healthHandler)
	mux.Handle("/metrics", observability.MetricsHandler())

	// Enable h2c for gRPC protocol support
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

	slog.Info("auth service listening", "addr", cfg.ListenAddr)
	if err := srv.ListenAndServe(); err != http.ErrServerClosed {
		slog.Error("listen error", "err", err)
		os.Exit(1)
	}

	slog.Info("server stopped gracefully")
}

// federationCORS wraps a handler with CORS headers for cross-origin federation
// ConnectRPC calls. Allows all origins since federation endpoints are designed
// to be called from any trusted instance's client.
func federationCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Connect-Protocol-Version, Authorization")
		w.Header().Set("Access-Control-Max-Age", "86400")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func healthHandler(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}
