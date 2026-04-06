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
	"github.com/mezalabs/meza/internal/embed"
	"github.com/mezalabs/meza/internal/middleware"
	bfnats "github.com/mezalabs/meza/internal/nats"
	"github.com/mezalabs/meza/internal/observability"
	"github.com/mezalabs/meza/internal/permissions"
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

	scyllaSession, err := database.NewScyllaSession(cfg.ScyllaHosts, "meza")
	if err != nil {
		slog.Error("connect scylla", "err", err)
		os.Exit(1)
	}
	defer scyllaSession.Close()

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
	messageStore := store.NewMessageStore(scyllaSession)
	inviteStore := store.NewInviteStore(pool)
	roleStore := store.NewRoleStore(pool)
	banStore := store.NewBanStore(pool)
	pinStore := store.NewPinStore(pool)
	emojiStore := store.NewEmojiStore(pool)
	auditStore := store.NewAuditLogStore(pool)
	soundboardStore := store.NewSoundboardStore(pool)
	reactionStore := store.NewReactionStore(pool)
	readStateStore := store.NewReadStateStore(pool)
	authStore := store.NewAuthStore(pool)
	mediaStore := store.NewMediaStore(pool)
	linkPreviewStore := store.NewLinkPreviewStore(pool)
	channelGroupStore := store.NewChannelGroupStore(pool)
	permissionOverrideStore := store.NewPermissionOverrideStore(pool)
	blockStore := store.NewBlockStore(pool)
	friendStore := store.NewFriendStore(pool)
	keyEnvelopeStore := store.NewKeyEnvelopeStore(pool)
	webhookStore := store.NewWebhookStore(pool)
	permCache := permissions.NewCache(rdb)

	// Clean up key bundles on expired/revoked invites (best-effort, non-blocking).
	if n, err := inviteStore.CleanExpiredKeyBundles(ctx); err != nil {
		slog.Warn("failed to clean expired invite key bundles", "err", err)
	} else if n > 0 {
		slog.Info("cleaned expired invite key bundles", "count", n)
	}

	svc := newChatService(chatServiceConfig{
		Pool:                    pool,
		ChatStore:               chatStore,
		MessageStore:            messageStore,
		InviteStore:             inviteStore,
		RoleStore:               roleStore,
		BanStore:                banStore,
		PinStore:                pinStore,
		EmojiStore:              emojiStore,
		AuditStore:              auditStore,
		SoundboardStore:         soundboardStore,
		ReactionStore:           reactionStore,
		ReadStateStore:          readStateStore,
		AuthStore:               authStore,
		BlockStore:              blockStore,
		FriendStore:             friendStore,
		MediaStore:              mediaStore,
		LinkPreviewStore:        linkPreviewStore,
		ChannelGroupStore:       channelGroupStore,
		PermissionOverrideStore: permissionOverrideStore,
		WebhookStore:            webhookStore,
		EncryptionChecker:       keyEnvelopeStore,
		NC:                      nc,
		RDB:                     rdb,
		PermCache:               permCache,
	})

	// Build interceptor options: user existence check, token blocklist, + optional Ed25519 dual validation
	blocklist := auth.NewTokenBlocklist(rdb)
	interceptorOpts := []auth.InterceptorOption{
		auth.WithUserExistenceCheck(authStore),
		auth.WithTokenBlocklist(blocklist),
	}

	// Load Ed25519 public key (required for JWT verification).
	ed25519PubKey, err := auth.LoadEd25519PublicKey(cfg.Ed25519PublicKey, cfg.Ed25519PublicKeyFile)
	if err != nil || ed25519PubKey == nil {
		slog.Error("Ed25519 public key is required", "err", err)
		os.Exit(1)
	}
	interceptorOpts = append(interceptorOpts, auth.WithVerificationCache(auth.NewVerificationCache()))
	slog.Info("Ed25519 token verification enabled for chat service")

	// ResolveInvite is public so unauthenticated users can preview invite links.
	interceptorOpts = append(interceptorOpts, auth.WithPublicProcedures(mezav1connect.ChatServiceResolveInviteProcedure))
	interceptor := connect.WithInterceptors(auth.NewConnectInterceptor(ed25519PubKey, interceptorOpts...))

	// Rate limit: 50 req/s burst 50 per IP for chat endpoints.
	// A single page load triggers ~10-15 concurrent API calls (listServers,
	// listChannels, listMembers, listRoles, getMessages, listEmojis, etc.),
	// so the burst must comfortably exceed that while still catching rapid-fire abuse.
	chatLimiter := ratelimit.New(50, 50)

	mux := http.NewServeMux()
	path, handler := mezav1connect.NewChatServiceHandler(svc, interceptor)
	mux.Handle(path, chatLimiter.Wrap(handler))

	// Start embed worker for link preview fetching.
	embedWorker := embed.NewWorker(nc, linkPreviewStore)
	embedSub, err := embedWorker.Start()
	if err != nil {
		slog.Error("start embed worker", "err", err)
		os.Exit(1)
	}
	defer embedSub.Drain()

	// Subscribe to internal key rotation events for system messages.
	keyRotSub, err := svc.subscribeKeyRotation()
	if err != nil {
		slog.Error("subscribe key rotation", "err", err)
		os.Exit(1)
	}
	defer keyRotSub.Drain()

	// Webhook execution endpoint — plain HTTP, not ConnectRPC, no JWT auth.
	// Uses token-in-URL authentication. Per-IP rate limit: 5 req/s burst 10.
	webhookLimiter := ratelimit.New(5, 10)
	mux.Handle("/webhooks/", webhookLimiter.Wrap(http.HandlerFunc(svc.handleWebhookExecute)))

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

	slog.Info("chat service listening", "addr", cfg.ListenAddr)
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
