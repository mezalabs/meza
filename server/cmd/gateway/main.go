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
	"github.com/meza-chat/meza/internal/federation"
	"github.com/meza-chat/meza/internal/middleware"
	bfnats "github.com/meza-chat/meza/internal/nats"
	"github.com/meza-chat/meza/internal/observability"
	"github.com/meza-chat/meza/internal/ratelimit"
	mezaRedis "github.com/meza-chat/meza/internal/redis"
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

	gw := NewGateway(chatStore, readStateStore, messageStore, chatClient, nc)
	gw.ed25519Keys = ed25519Keys
	gw.instanceURL = cfg.FederationInstanceURL
	gw.verificationCache = auth.NewVerificationCache()
	gw.capabilities = instanceCapabilities{
		ProtocolVersion:      1,
		MediaEnabled:         cfg.S3Endpoint != "",
		VoiceEnabled:         cfg.LiveKitHost != "",
		NotificationsEnabled: false, // Phase D
	}

	if err := gw.Start(ctx); err != nil {
		slog.Error("start gateway", "err", err)
		os.Exit(1)
	}

	// Federation service setup
	authStore := store.NewAuthStore(pool)
	federationStore := store.NewFederationStore(pool)
	inviteStore := store.NewInviteStore(pool)

	fedSvc := &gatewayFederationService{
		authStore:       authStore,
		federationStore: federationStore,
		chatStore:       chatStore,
		inviteStore:     inviteStore,
		ed25519Keys:     ed25519Keys,
		instanceURL:     cfg.FederationInstanceURL,
	}

	// Set up federation verifier and Redis if federation is enabled
	if cfg.FederationEnabled && ed25519Keys != nil {
		trustedServers := auth.ParseTrustedHomeServers(cfg.TrustedHomeServers)
		jwksClient := federation.NewJWKSClient()
		if err := jwksClient.EagerLoad(ctx, trustedServers); err != nil {
			slog.Error("eager loading JWKS", "err", err)
			os.Exit(1)
		}
		jwksClient.StartBackgroundRefresh(ctx, trustedServers)
		fedSvc.verifier = federation.NewVerifier(jwksClient, cfg.FederationInstanceURL, trustedServers)

		// Connect Redis for jti replay protection and token blocklisting
		if cfg.RedisURL != "" {
			rdb, err := mezaRedis.NewClient(ctx, cfg.RedisURL)
			if err != nil {
				slog.Error("connect redis for federation", "err", err)
				os.Exit(1)
			}
			defer rdb.Close()
			fedSvc.redisClient = rdb
			fedSvc.tokenBlocklist = auth.NewTokenBlocklist(rdb)
		} else {
			slog.Error("federation requires Redis for jti replay protection and token blocklisting")
			os.Exit(1)
		}
	}

	// Rate limit: 10 req/s burst 3 per IP for WebSocket connections
	wsLimiter := ratelimit.New(10, 3)

	mux := http.NewServeMux()
	mux.Handle("/ws", wsLimiter.WrapFunc(gw.HandleWebSocket))
	mux.HandleFunc("/health", healthHandler)
	mux.Handle("/metrics", observability.MetricsHandler())

	// Federation ConnectRPC handler with CORS and rate limiting.
	// Uses the optional interceptor (join/refresh are unauthenticated, leave requires JWT).
	fedInterceptorOpts := []auth.InterceptorOption{
		auth.WithVerificationCache(auth.NewVerificationCache()),
	}
	fedPath, fedHandler := mezav1connect.NewFederationServiceHandler(fedSvc,
		connect.WithInterceptors(auth.NewOptionalConnectInterceptor(ed25519Keys.PublicKey, fedInterceptorOpts...)),
	)
	fedLimiter := ratelimit.New(3, 5) // Tighter limits for federation endpoints
	mux.Handle(fedPath, federationCORS(fedLimiter.Wrap(fedHandler)))

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
