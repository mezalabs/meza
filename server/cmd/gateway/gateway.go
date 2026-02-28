package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"connectrpc.com/connect"
	"github.com/coder/websocket"
	"golang.org/x/sync/errgroup"

	v1 "github.com/meza-chat/meza/gen/meza/v1"
	"github.com/meza-chat/meza/gen/meza/v1/mezav1connect"
	"github.com/meza-chat/meza/internal/auth"
	"github.com/meza-chat/meza/internal/store"
	"github.com/meza-chat/meza/internal/subjects"
	"github.com/nats-io/nats.go"
	"google.golang.org/protobuf/proto"
)

const (
	sendBufSize           = 256
	maxMessageSize        = 64 * 1024 // 64KB
	pingInterval          = 30 * time.Second
	heartbeatFlush        = 5 * time.Second
	writeTimeout          = 10 * time.Second
	authTimeout           = 5 * time.Second
	tokenCacheTTL         = 1 * time.Minute
	refreshDebounceDelay  = 150 * time.Millisecond
	unreadCountConcurrency = 10 // max parallel ScyllaDB queries for unread counts
)

type Client struct {
	UserID   string
	DeviceID string
	Conn     *websocket.Conn
	Channels []string
	Servers  []string
	Send     chan []byte

	cancel   context.CancelFunc
	closeOnce sync.Once // guards close(Send)

	// Per-user NATS subscription for dynamic channel updates.
	userSub *nats.Subscription

	// Per-client debounce timer for refreshClientChannels.
	refreshMu    sync.Mutex
	refreshTimer *time.Timer

	// Cached internal token (Fix 4: avoid per-message JWT generation).
	tokenMu     sync.Mutex
	cachedToken string
	tokenExpiry time.Time
}

func (c *Client) key() string {
	return c.UserID + ":" + c.DeviceID
}

// closeSend safely closes the Send channel exactly once.
func (c *Client) closeSend() {
	c.closeOnce.Do(func() {
		close(c.Send)
	})
}

type Gateway struct {
	ed25519Keys       *auth.Ed25519Keys       // Ed25519 keys for JWT signing/verification
	instanceURL       string                  // This instance's URL for iss claim
	verificationCache *auth.VerificationCache // Caches validated JWT claims to avoid repeated Ed25519 verification
	originPatterns    []string
	chatStore      store.ChatStorer
	readStateStore store.ReadStateStorer
	messageStore   store.MessageStorer
	chatClient     mezav1connect.ChatServiceClient
	nc             *nats.Conn

	mu             sync.RWMutex
	clients        map[string]*Client              // userID:deviceID -> *Client
	userClients    map[string][]*Client             // userID -> slice of clients
	channelClients map[string]map[*Client]struct{} // channelID -> set of clients
	serverClients  map[string]map[*Client]struct{} // serverID -> set of clients

	heartbeatMu    sync.Mutex
	heartbeatBatch map[string]struct{} // userIDs to flush
}

func NewGateway(chatStore store.ChatStorer, readStateStore store.ReadStateStorer, messageStore store.MessageStorer, chatClient mezav1connect.ChatServiceClient, nc *nats.Conn) *Gateway {
	// Fix 3: Read allowed origins from environment variable instead of
	// hardcoding a wildcard. Defaults to "*" for development.
	origins := parseAllowedOrigins(os.Getenv("ALLOWED_ORIGINS"))

	return &Gateway{
		originPatterns: origins,
		chatStore:      chatStore,
		readStateStore: readStateStore,
		messageStore:   messageStore,
		chatClient:     chatClient,
		nc:             nc,
		clients:        make(map[string]*Client),
		userClients:    make(map[string][]*Client),
		channelClients: make(map[string]map[*Client]struct{}),
		serverClients:  make(map[string]map[*Client]struct{}),
		heartbeatBatch: make(map[string]struct{}),
	}
}

// parseAllowedOrigins splits a comma-separated origin string into a slice.
// Returns []string{"*"} when the input is empty (development default).
func parseAllowedOrigins(raw string) []string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return []string{"*"}
	}
	parts := strings.Split(raw, ",")
	origins := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p != "" {
			origins = append(origins, p)
		}
	}
	if len(origins) == 0 {
		return []string{"*"}
	}
	return origins
}

func (gw *Gateway) Start(ctx context.Context) error {
	// Single wildcard NATS subscription for all channel delivery
	_, err := gw.nc.Subscribe(subjects.DeliverChannelWildcard(), func(msg *nats.Msg) {
		// Subject format: meza.deliver.channel.<channelID>
		parts := strings.Split(msg.Subject, ".")
		if len(parts) < 4 {
			return
		}
		channelID := parts[3]

		envelope, err := makeEnvelope(v1.GatewayOpCode_GATEWAY_OP_EVENT, msg.Data)
		if err != nil {
			slog.Error("marshaling channel event envelope", "err", err)
			return
		}

		gw.mu.RLock()
		clients := gw.channelClients[channelID]
		for client := range clients {
			select {
			case client.Send <- envelope:
			default:
				// Slow consumer — close the connection
				go gw.closeSlowConsumer(client)
			}
		}
		gw.mu.RUnlock()
	})
	if err != nil {
		return fmt.Errorf("subscribe channel wildcard: %w", err)
	}

	// Server-level channel events (channel create/update/delete, channel member add/remove)
	// — fan out to all clients in that server, but scope private channel events to
	// channel members only. Uses 1-byte privacy prefix to avoid full protobuf
	// deserialization.
	_, err = gw.nc.Subscribe(subjects.ServerChannelWildcard(), func(msg *nats.Msg) {
		// Subject format: meza.server.channel.<serverID>
		parts := strings.Split(msg.Subject, ".")
		if len(parts) < 4 {
			return
		}
		serverID := parts[3]

		// Decode privacy prefix without full protobuf deserialization.
		eventData, channelID, err := subjects.DecodeServerChannelEvent(msg.Data)
		if err != nil {
			slog.Error("decoding server channel event", "err", err)
			return
		}

		envelope, err := makeEnvelope(v1.GatewayOpCode_GATEWAY_OP_EVENT, eventData)
		if err != nil {
			slog.Error("marshaling server event envelope", "err", err)
			return
		}

		gw.mu.RLock()
		if channelID != "" {
			// Private channel event — only deliver to clients subscribed to this channel.
			for client := range gw.channelClients[channelID] {
				select {
				case client.Send <- envelope:
				default:
					go gw.closeSlowConsumer(client)
				}
			}
		} else {
			// Public channel event — deliver to all server members.
			for client := range gw.serverClients[serverID] {
				select {
				case client.Send <- envelope:
				default:
					go gw.closeSlowConsumer(client)
				}
			}
		}
		gw.mu.RUnlock()
	})
	if err != nil {
		return fmt.Errorf("subscribe server channel wildcard: %w", err)
	}

	// Server-level broadcast events — member, role, emoji, soundboard, channel group.
	// All use the same pattern: extract serverID from subject, fan out to serverClients.
	serverBroadcastSubjects := []string{
		subjects.ServerMemberWildcard(),
		subjects.ServerRoleWildcard(),
		subjects.ServerEmojiWildcard(),
		subjects.ServerSoundboardWildcard(),
		subjects.ServerChannelGroupWildcard(),
	}
	for _, subject := range serverBroadcastSubjects {
		if err := gw.subscribeServerBroadcast(subject); err != nil {
			return err
		}
	}

	// Per-user read state events — deliver only to the user's own clients.
	// Uses userClients index for O(1) lookup instead of O(n) full scan.
	_, err = gw.nc.Subscribe(subjects.UserReadStateWildcard(), func(msg *nats.Msg) {
		// Subject format: meza.user.readstate.<userID>
		parts := strings.Split(msg.Subject, ".")
		if len(parts) < 4 {
			return
		}
		userID := parts[3]

		envelope, err := makeEnvelope(v1.GatewayOpCode_GATEWAY_OP_EVENT, msg.Data)
		if err != nil {
			slog.Error("marshaling read state event envelope", "err", err)
			return
		}

		gw.mu.RLock()
		for _, client := range gw.userClients[userID] {
			select {
			case client.Send <- envelope:
			default:
				go gw.closeSlowConsumer(client)
			}
		}
		gw.mu.RUnlock()
	})
	if err != nil {
		return fmt.Errorf("subscribe user read state wildcard: %w", err)
	}

	// Presence update events — fan out to all members of shared servers.
	// Subject format: meza.presence.update.<userID>
	_, err = gw.nc.Subscribe(subjects.PresenceUpdateWildcard(), func(msg *nats.Msg) {
		parts := strings.Split(msg.Subject, ".")
		if len(parts) < 4 {
			return
		}
		userID := parts[3]

		envelope, err := makeEnvelope(v1.GatewayOpCode_GATEWAY_OP_EVENT, msg.Data)
		if err != nil {
			slog.Error("marshaling presence update envelope", "err", err)
			return
		}

		// Find the user's clients to derive which servers they belong to,
		// then fan out to all clients in those servers (deduplicated).
		gw.mu.RLock()
		userCls := gw.userClients[userID]
		if len(userCls) == 0 {
			gw.mu.RUnlock()
			return
		}
		// Collect server IDs from the user's clients.
		serverSet := make(map[string]struct{})
		for _, c := range userCls {
			for _, srvID := range c.Servers {
				serverSet[srvID] = struct{}{}
			}
		}
		// Fan out to all clients in those servers, deduplicated.
		sent := make(map[*Client]struct{})
		for srvID := range serverSet {
			for client := range gw.serverClients[srvID] {
				if _, already := sent[client]; already {
					continue
				}
				sent[client] = struct{}{}
				select {
				case client.Send <- envelope:
				default:
					go gw.closeSlowConsumer(client)
				}
			}
		}
		gw.mu.RUnlock()
	})
	if err != nil {
		return fmt.Errorf("subscribe presence update wildcard: %w", err)
	}

	// Start heartbeat flusher
	go gw.heartbeatFlusher(ctx)

	return nil
}

// subscribeServerBroadcast subscribes to a server-level wildcard NATS subject
// and fans out each message to all clients in the corresponding server.
// Subject format is always: meza.server.<entity>.<serverID>.
func (gw *Gateway) subscribeServerBroadcast(subject string) error {
	_, err := gw.nc.Subscribe(subject, func(msg *nats.Msg) {
		parts := strings.Split(msg.Subject, ".")
		if len(parts) < 4 {
			return
		}
		serverID := parts[3]

		envelope, err := makeEnvelope(v1.GatewayOpCode_GATEWAY_OP_EVENT, msg.Data)
		if err != nil {
			slog.Error("marshaling server broadcast envelope", "err", err, "subject", msg.Subject)
			return
		}

		gw.mu.RLock()
		for client := range gw.serverClients[serverID] {
			select {
			case client.Send <- envelope:
			default:
				go gw.closeSlowConsumer(client)
			}
		}
		gw.mu.RUnlock()
	})
	if err != nil {
		return fmt.Errorf("subscribe %s: %w", subject, err)
	}
	return nil
}

func (gw *Gateway) closeSlowConsumer(client *Client) {
	slog.Warn("slow consumer, closing", "user", client.UserID, "device", client.DeviceID)
	client.Conn.Close(websocket.StatusPolicyViolation, "send buffer full")
}

// CloseAllConnections sends a close frame to every connected WebSocket client
// so they can cleanly reconnect to another pod during rolling deployments.
func (gw *Gateway) CloseAllConnections() {
	gw.mu.RLock()
	clients := make([]*Client, 0, len(gw.clients))
	for _, c := range gw.clients {
		clients = append(clients, c)
	}
	gw.mu.RUnlock()

	slog.Info("closing all websocket connections", "count", len(clients))
	for _, c := range clients {
		c.Conn.Close(websocket.StatusGoingAway, "server shutting down")
	}
}

func (gw *Gateway) heartbeatFlusher(ctx context.Context) {
	ticker := time.NewTicker(heartbeatFlush)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			gw.heartbeatMu.Lock()
			batch := gw.heartbeatBatch
			gw.heartbeatBatch = make(map[string]struct{})
			gw.heartbeatMu.Unlock()

			for userID := range batch {
				gw.nc.Publish(subjects.PresenceHeartbeat(userID), nil)
			}
		}
	}
}

func (gw *Gateway) HandleWebSocket(w http.ResponseWriter, r *http.Request) {
	// Fix 2: Accept WebSocket first, then authenticate via first message.
	// Fix 3: Use configured origin patterns instead of wildcard.
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		OriginPatterns: gw.originPatterns,
	})
	if err != nil {
		slog.Error("websocket accept", "err", err)
		return
	}

	// Perform first-message authentication with a deadline.
	claims, err := gw.authenticateFirstMessage(conn)
	if err != nil {
		slog.Warn("websocket auth failed", "err", err, "remote", r.RemoteAddr)
		conn.Close(websocket.StatusPolicyViolation, "authentication failed")
		return
	}

	// Fresh context — do NOT use r.Context() after upgrade.
	// Fix 1: shared context that both pumps respect.
	ctx, cancel := context.WithCancel(context.Background())

	client := &Client{
		UserID:   claims.UserID,
		DeviceID: claims.DeviceID,
		Conn:     conn,
		Send:     make(chan []byte, sendBufSize),
		cancel:   cancel,
	}

	// Fetch user's channel IDs
	channelIDs, err := gw.chatStore.GetUserChannels(ctx, claims.UserID)
	if err != nil {
		slog.Error("get user channels", "err", err, "user", claims.UserID)
		conn.Close(websocket.StatusInternalError, "failed to get channels")
		cancel()
		return
	}
	client.Channels = channelIDs

	// Fetch user's servers for server-level event routing
	servers, err := gw.chatStore.ListServers(ctx, claims.UserID)
	if err != nil {
		slog.Error("get user servers", "err", err, "user", claims.UserID)
		conn.Close(websocket.StatusInternalError, "failed to get servers")
		cancel()
		return
	}
	serverIDs := make([]string, len(servers))
	for i, srv := range servers {
		serverIDs[i] = srv.ID
	}
	client.Servers = serverIDs

	// Register client
	gw.addClient(client)

	// Subscribe to per-user subscription signals.
	// Empty payload = refresh signal (channel membership changed) — debounce and refresh.
	// Non-empty payload = forward-to-client event (block/friend/DM) — just forward, no refresh.
	sub, err := gw.nc.Subscribe(subjects.UserSubscription(claims.UserID), func(msg *nats.Msg) {
		if len(msg.Data) > 0 {
			// Forward-only event (block/friend/DM) — send to WebSocket, skip refresh.
			envelope, err := makeEnvelope(v1.GatewayOpCode_GATEWAY_OP_EVENT, msg.Data)
			if err != nil {
				slog.Error("marshaling user subscription event envelope", "err", err)
			} else {
				select {
				case client.Send <- envelope:
				default:
					go gw.closeSlowConsumer(client)
				}
			}
			return
		}
		// Empty payload = refresh signal — debounce.
		gw.debouncedRefreshClientChannels(ctx, client)
	})
	if err != nil {
		slog.Error("subscribe user subscription", "err", err, "user", claims.UserID)
	} else {
		client.userSub = sub
	}

	// Compute read states with unread counts for the READY payload.
	// Parallelized with bounded concurrency to avoid N+1 ScyllaDB queries.
	type readyReadState struct {
		ChannelID         string `json:"channel_id"`
		LastReadMessageID string `json:"last_read_message_id"`
		UnreadCount       int32  `json:"unread_count"`
	}
	var readStates []readyReadState
	if states, err := gw.readStateStore.GetReadStates(ctx, claims.UserID); err != nil {
		slog.Error("get read states for ready", "err", err, "user", claims.UserID)
	} else {
		readStates = make([]readyReadState, len(states))
		// Pre-fill known fields; counts will be filled in parallel.
		for i, rs := range states {
			readStates[i] = readyReadState{
				ChannelID:         rs.ChannelID,
				LastReadMessageID: rs.LastReadMessageID,
			}
		}

		g, gctx := errgroup.WithContext(ctx)
		g.SetLimit(unreadCountConcurrency)
		for i, rs := range states {
			i, rs := i, rs // capture loop variables
			g.Go(func() error {
				count, err := gw.messageStore.CountMessagesAfter(gctx, rs.ChannelID, rs.LastReadMessageID)
				if err != nil {
					slog.Error("count unread for ready", "err", err, "user", claims.UserID, "channel", rs.ChannelID)
					count = 0
				}
				readStates[i].UnreadCount = count
				return nil // don't fail the group; zero is acceptable fallback
			})
		}
		g.Wait()
	}

	// Send READY — V1 simplification: payload is JSON text encoded as bytes
	// inside the protobuf envelope (same JSON-in-protobuf pattern as IDENTIFY).
	// Contains { user_id, channel_ids, read_states } for the client's initial state.
	readyPayload, _ := json.Marshal(map[string]any{
		"user_id":     claims.UserID,
		"channel_ids": channelIDs,
		"read_states": readStates,
	})
	readyEnvelope, err := makeEnvelope(v1.GatewayOpCode_GATEWAY_OP_READY, readyPayload)
	if err != nil {
		slog.Error("marshaling ready envelope", "err", err, "user", claims.UserID)
		conn.Close(websocket.StatusInternalError, "internal error")
		cancel()
		return
	}
	client.Send <- readyEnvelope

	// Fix 1: Start both pumps. When either exits it cancels the shared
	// context, causing the other to exit. A WaitGroup ensures both have
	// finished before we run cleanup.
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		defer cancel() // if writePump exits first, cancel readPump
		gw.writePump(ctx, client)
	}()
	go func() {
		defer wg.Done()
		defer cancel() // if readPump exits first, cancel writePump
		gw.readPump(ctx, client)
	}()

	wg.Wait()
	gw.removeClient(client)
}

// authenticateFirstMessage reads the first WebSocket message and expects an
// IDENTIFY envelope whose payload is a JSON object with a "token" field.
// A 5-second deadline is enforced.
//
// V1 simplification: IDENTIFY and READY use JSON-in-protobuf instead of
// dedicated proto message types. The outer envelope is protobuf
// (GatewayEnvelope), but the auth/ready payloads are JSON text encoded as
// bytes. This avoids needing separate IdentifyPayload/ReadyPayload proto
// messages for the handshake during early development. The client-side
// gateway.ts mirrors this pattern.
func (gw *Gateway) authenticateFirstMessage(conn *websocket.Conn) (*auth.Claims, error) {
	ctx, cancel := context.WithTimeout(context.Background(), authTimeout)
	defer cancel()

	_, data, err := conn.Read(ctx)
	if err != nil {
		return nil, fmt.Errorf("reading auth message: %w", err)
	}

	env, err := parseEnvelope(data)
	if err != nil {
		return nil, fmt.Errorf("parsing auth envelope: %w", err)
	}

	if env.Op != v1.GatewayOpCode_GATEWAY_OP_IDENTIFY {
		return nil, fmt.Errorf("expected IDENTIFY op, got %v", env.Op)
	}

	// Payload is JSON: {"token":"<jwt>"}
	var identifyPayload struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(env.Payload, &identifyPayload); err != nil {
		return nil, fmt.Errorf("parsing identify payload: %w", err)
	}
	if identifyPayload.Token == "" {
		return nil, fmt.Errorf("empty token in identify payload")
	}

	// Check verification cache first to avoid repeated Ed25519 verification
	if gw.verificationCache != nil {
		if claims, ok := gw.verificationCache.Get(identifyPayload.Token); ok {
			return claims, nil
		}
	}

	claims, err := auth.ValidateTokenEd25519(identifyPayload.Token, gw.ed25519Keys.PublicKey)
	if err != nil {
		return nil, fmt.Errorf("invalid token: %w", err)
	}
	if claims.IsRefresh {
		return nil, fmt.Errorf("refresh token cannot be used for authentication")
	}

	// Cache validated claims
	if gw.verificationCache != nil {
		gw.verificationCache.Put(identifyPayload.Token, claims, time.Now().Add(1*time.Hour))
	}

	return claims, nil
}

func (gw *Gateway) addClient(client *Client) {
	gw.mu.Lock()
	defer gw.mu.Unlock()

	gw.clients[client.key()] = client
	// Maintain userClients index.
	gw.userClients[client.UserID] = append(gw.userClients[client.UserID], client)
	for _, chID := range client.Channels {
		if gw.channelClients[chID] == nil {
			gw.channelClients[chID] = make(map[*Client]struct{})
		}
		gw.channelClients[chID][client] = struct{}{}
	}
	for _, srvID := range client.Servers {
		if gw.serverClients[srvID] == nil {
			gw.serverClients[srvID] = make(map[*Client]struct{})
		}
		gw.serverClients[srvID][client] = struct{}{}
	}

	// Publish device-connected event for the notification service.
	gw.nc.Publish(subjects.DeviceConnected(client.UserID), []byte(client.DeviceID))
}

func (gw *Gateway) removeClient(client *Client) {
	// Unsubscribe from per-user channel refresh subject.
	if client.userSub != nil {
		client.userSub.Unsubscribe()
	}

	// Stop any pending debounce timer.
	client.refreshMu.Lock()
	if client.refreshTimer != nil {
		client.refreshTimer.Stop()
		client.refreshTimer = nil
	}
	client.refreshMu.Unlock()

	gw.mu.Lock()
	defer gw.mu.Unlock()

	// Remove from userClients index.
	if uc := gw.userClients[client.UserID]; len(uc) > 0 {
		filtered := uc[:0]
		for _, c := range uc {
			if c != client {
				filtered = append(filtered, c)
			}
		}
		if len(filtered) == 0 {
			delete(gw.userClients, client.UserID)
		} else {
			gw.userClients[client.UserID] = filtered
		}
	}
	for _, chID := range client.Channels {
		delete(gw.channelClients[chID], client)
		if len(gw.channelClients[chID]) == 0 {
			delete(gw.channelClients, chID)
		}
	}
	for _, srvID := range client.Servers {
		delete(gw.serverClients[srvID], client)
		if len(gw.serverClients[srvID]) == 0 {
			delete(gw.serverClients, srvID)
		}
	}
	// Fix 1: use sync.Once to prevent double-close panic on Send channel.
	client.closeSend()
	delete(gw.clients, client.key())
	client.Conn.Close(websocket.StatusNormalClosure, "")
	client.cancel()

	// Publish device-disconnected event for the notification service.
	gw.nc.Publish(subjects.DeviceDisconnected(client.UserID), []byte(client.DeviceID))
}

// debouncedRefreshClientChannels coalesces rapid refresh signals using a
// per-client timer. Actual refresh executes after refreshDebounceDelay of
// inactivity, preventing 2 heavy PostgreSQL queries per rapid NATS signal
// (e.g., user added to 10 channels simultaneously).
func (gw *Gateway) debouncedRefreshClientChannels(ctx context.Context, client *Client) {
	client.refreshMu.Lock()
	defer client.refreshMu.Unlock()

	// Reset existing timer if present.
	if client.refreshTimer != nil {
		client.refreshTimer.Stop()
	}
	client.refreshTimer = time.AfterFunc(refreshDebounceDelay, func() {
		gw.refreshClientChannels(ctx, client)
	})
}

// refreshClientChannels re-fetches the user's channels and servers, then
// updates the channel and server registries. Called when the user joins or
// leaves a server.
func (gw *Gateway) refreshClientChannels(ctx context.Context, client *Client) {
	// Fetch new channel list outside the lock to avoid holding it during I/O.
	newChannels, err := gw.chatStore.GetUserChannels(ctx, client.UserID)
	if err != nil {
		slog.Error("refresh user channels", "err", err, "user", client.UserID)
		return
	}

	// Also refresh servers.
	newServers, err := gw.chatStore.ListServers(ctx, client.UserID)
	if err != nil {
		slog.Error("refresh user servers", "err", err, "user", client.UserID)
		return
	}
	newServerIDs := make([]string, len(newServers))
	for i, srv := range newServers {
		newServerIDs[i] = srv.ID
	}

	newChSet := make(map[string]bool, len(newChannels))
	for _, ch := range newChannels {
		newChSet[ch] = true
	}
	newSrvSet := make(map[string]bool, len(newServerIDs))
	for _, s := range newServerIDs {
		newSrvSet[s] = true
	}

	gw.mu.Lock()
	defer gw.mu.Unlock()

	// Build old sets inside the lock to prevent races.
	oldChSet := make(map[string]bool, len(client.Channels))
	for _, ch := range client.Channels {
		oldChSet[ch] = true
	}
	oldSrvSet := make(map[string]bool, len(client.Servers))
	for _, s := range client.Servers {
		oldSrvSet[s] = true
	}

	// Remove channels no longer present.
	for _, chID := range client.Channels {
		if !newChSet[chID] {
			delete(gw.channelClients[chID], client)
			if len(gw.channelClients[chID]) == 0 {
				delete(gw.channelClients, chID)
			}
		}
	}
	// Add new channels.
	for _, chID := range newChannels {
		if !oldChSet[chID] {
			if gw.channelClients[chID] == nil {
				gw.channelClients[chID] = make(map[*Client]struct{})
			}
			gw.channelClients[chID][client] = struct{}{}
		}
	}
	client.Channels = newChannels

	// Remove servers no longer present.
	for _, srvID := range client.Servers {
		if !newSrvSet[srvID] {
			delete(gw.serverClients[srvID], client)
			if len(gw.serverClients[srvID]) == 0 {
				delete(gw.serverClients, srvID)
			}
		}
	}
	// Add new servers.
	for _, srvID := range newServerIDs {
		if !oldSrvSet[srvID] {
			if gw.serverClients[srvID] == nil {
				gw.serverClients[srvID] = make(map[*Client]struct{})
			}
			gw.serverClients[srvID][client] = struct{}{}
		}
	}
	client.Servers = newServerIDs
}

func (gw *Gateway) readPump(ctx context.Context, client *Client) {
	client.Conn.SetReadLimit(maxMessageSize)

	for {
		_, data, err := client.Conn.Read(ctx)
		if err != nil {
			return
		}

		env, err := parseEnvelope(data)
		if err != nil {
			slog.Warn("invalid envelope", "err", err, "user", client.UserID)
			continue
		}

		switch env.Op {
		case v1.GatewayOpCode_GATEWAY_OP_HEARTBEAT:
			ack, err := makeEnvelope(v1.GatewayOpCode_GATEWAY_OP_HEARTBEAT_ACK, nil)
			if err != nil {
				slog.Error("marshaling heartbeat ack", "err", err)
				continue
			}
			client.Send <- ack
			gw.heartbeatMu.Lock()
			gw.heartbeatBatch[client.UserID] = struct{}{}
			gw.heartbeatMu.Unlock()

		case v1.GatewayOpCode_GATEWAY_OP_TYPING_START:
			typingEvent := &v1.TypingEvent{}
			if err := proto.Unmarshal(env.Payload, typingEvent); err != nil {
				slog.Warn("invalid typing_start payload", "err", err)
				continue
			}
			// Override userId with authenticated identity to prevent spoofing.
			typingEvent.UserId = client.UserID

			// Verify channel membership before broadcasting.
			found := false
			for _, ch := range client.Channels {
				if ch == typingEvent.ChannelId {
					found = true
					break
				}
			}
			if !found {
				slog.Warn("typing_start for non-member channel", "user", client.UserID, "channel", typingEvent.ChannelId)
				continue
			}
			event := &v1.Event{
				Type: v1.EventType_EVENT_TYPE_TYPING_START,
				Payload: &v1.Event_TypingStart{
					TypingStart: typingEvent,
				},
			}
			eventBytes, err := proto.Marshal(event)
			if err != nil {
				slog.Warn("marshal typing event", "err", err)
				continue
			}
			gw.nc.Publish(subjects.DeliverChannel(typingEvent.ChannelId), eventBytes)

		case v1.GatewayOpCode_GATEWAY_OP_SEND_MESSAGE:
			// Forward as ConnectRPC call to chat service
			sendReq := &v1.SendMessageRequest{}
			if err := proto.Unmarshal(env.Payload, sendReq); err != nil {
				slog.Warn("invalid send_message payload", "err", err)
				continue
			}
			// Fix 4: use cached internal token instead of generating per-message.
			token, err := gw.getInternalToken(client)
			if err != nil {
				slog.Error("generate internal token", "err", err, "user", client.UserID)
				continue
			}
			req := connect.NewRequest(sendReq)
			req.Header().Set("Authorization", "Bearer "+token)
			_, err = gw.chatClient.SendMessage(ctx, req)
			if err != nil {
				slog.Warn("send message forwarding", "err", err, "user", client.UserID)
			}
		}
	}
}

func (gw *Gateway) writePump(ctx context.Context, client *Client) {
	ticker := time.NewTicker(pingInterval)
	defer ticker.Stop()

	for {
		select {
		case msg, ok := <-client.Send:
			if !ok {
				return
			}
			writeCtx, cancel := context.WithTimeout(ctx, writeTimeout)
			err := client.Conn.Write(writeCtx, websocket.MessageBinary, msg)
			cancel()
			if err != nil {
				return
			}
		case <-ticker.C:
			pingCtx, cancel := context.WithTimeout(ctx, writeTimeout)
			err := client.Conn.Ping(pingCtx)
			cancel()
			if err != nil {
				return
			}
		case <-ctx.Done():
			return
		}
	}
}

// getInternalToken returns a cached internal JWT for the client, regenerating
// it only when the cache has expired (Fix 4).
func (gw *Gateway) getInternalToken(client *Client) (string, error) {
	client.tokenMu.Lock()
	defer client.tokenMu.Unlock()

	if client.cachedToken != "" && time.Now().Before(client.tokenExpiry) {
		return client.cachedToken, nil
	}

	token, _, err := auth.GenerateTokenPairEd25519(client.UserID, client.DeviceID, gw.ed25519Keys, gw.instanceURL, false)
	if err != nil {
		return "", fmt.Errorf("generating internal token: %w", err)
	}

	client.cachedToken = token
	client.tokenExpiry = time.Now().Add(tokenCacheTTL)
	return token, nil
}
