package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	webpush "github.com/SherClockHolmes/webpush-go"
	"connectrpc.com/connect"
	"firebase.google.com/go/v4/messaging"
	"github.com/nats-io/nats.go"
	"github.com/redis/go-redis/v9"
	"google.golang.org/protobuf/proto"

	v1 "github.com/mezalabs/meza/gen/meza/v1"
	"github.com/mezalabs/meza/internal/auth"
	"github.com/mezalabs/meza/internal/config"
	"github.com/mezalabs/meza/internal/models"
	"github.com/mezalabs/meza/internal/store"
	"github.com/mezalabs/meza/internal/subjects"
)

const (
	// Redis key prefix for tracking connected devices per user.
	connectedDevicesPrefix = "connected_devices:"

	// connectedDevicesTTL is the expiry applied to each connected_devices set.
	// If the gateway crashes without sending disconnect events, entries
	// expire automatically so push notifications are no longer suppressed.
	// Heartbeats refresh this TTL, so the value should comfortably exceed
	// the gateway's heartbeat flush interval (5 s).
	connectedDevicesTTL = 5 * time.Minute

	// Default throttle window: 1 push per 30s per channel per user.
	defaultThrottleSeconds = 30

	// everyoneBatchSize is the number of users processed per batch when
	// fan-out notifying @everyone mentions.
	everyoneBatchSize = 300

	// everyoneConcurrency is the max number of goroutines processing
	// @everyone batches concurrently.
	everyoneConcurrency = 8
)

// userLooker is the narrow slice of AuthStorer the notification service
// needs for enriching DM push titles with the sender's display name.
type userLooker interface {
	GetUserByID(ctx context.Context, userID string) (*models.User, error)
}

type notificationService struct {
	deviceStore store.DeviceStorer
	prefStore   store.NotificationPreferenceStorer
	chatStore   store.ChatStorer
	userStore   userLooker
	rdb         *redis.Client
	nc          *nats.Conn
	cfg         *config.Config
	fcmClient   *messaging.Client
}

func newNotificationService(
	deviceStore store.DeviceStorer,
	prefStore store.NotificationPreferenceStorer,
	chatStore store.ChatStorer,
	userStore userLooker,
	rdb *redis.Client,
	nc *nats.Conn,
	cfg *config.Config,
	fcmClient *messaging.Client,
) *notificationService {
	return &notificationService{
		deviceStore: deviceStore,
		prefStore:   prefStore,
		chatStore:   chatStore,
		userStore:   userStore,
		rdb:         rdb,
		nc:          nc,
		cfg:         cfg,
		fcmClient:   fcmClient,
	}
}

// --- ConnectRPC handlers ---

func (s *notificationService) GetNotificationPreferences(
	ctx context.Context,
	req *connect.Request[v1.GetNotificationPreferencesRequest],
) (*connect.Response[v1.GetNotificationPreferencesResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, fmt.Errorf("not authenticated"))
	}

	prefs, err := s.prefStore.GetPreferences(ctx, userID)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("get preferences: %w", err))
	}

	pbPrefs := make([]*v1.NotificationPreference, len(prefs))
	for i, p := range prefs {
		pbPrefs[i] = &v1.NotificationPreference{
			ScopeType: p.ScopeType,
			ScopeId:   p.ScopeID,
			Level:     p.Level,
		}
	}

	return connect.NewResponse(&v1.GetNotificationPreferencesResponse{
		Preferences: pbPrefs,
	}), nil
}

func (s *notificationService) UpdateNotificationPreference(
	ctx context.Context,
	req *connect.Request[v1.UpdateNotificationPreferenceRequest],
) (*connect.Response[v1.UpdateNotificationPreferenceResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, fmt.Errorf("not authenticated"))
	}

	msg := req.Msg
	// Validate scope_type.
	switch msg.ScopeType {
	case "global", "server", "channel":
	default:
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("invalid scope_type %q", msg.ScopeType))
	}
	// Validate level.
	switch msg.Level {
	case "all", "mentions_only", "nothing":
	default:
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("invalid level %q", msg.Level))
	}

	// Verify membership for server/channel scopes.
	if msg.ScopeType == "server" && msg.ScopeId != "" {
		if _, err := s.chatStore.GetMember(ctx, userID, msg.ScopeId); err != nil {
			return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("not a member of this server"))
		}
	}
	if msg.ScopeType == "channel" && msg.ScopeId != "" {
		if _, _, err := s.chatStore.GetChannelAndCheckMembership(ctx, msg.ScopeId, userID); err != nil {
			return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("channel not found"))
		}
	}

	// "all" at global scope is the default — delete the preference instead of storing it.
	if msg.ScopeType == "global" && msg.Level == "all" {
		if err := s.prefStore.DeletePreference(ctx, userID, msg.ScopeType, msg.ScopeId); err != nil {
			return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("delete preference: %w", err))
		}
		return connect.NewResponse(&v1.UpdateNotificationPreferenceResponse{}), nil
	}

	pref := &models.NotificationPreference{
		UserID:    userID,
		ScopeType: msg.ScopeType,
		ScopeID:   msg.ScopeId,
		Level:     msg.Level,
	}
	if err := s.prefStore.UpsertPreference(ctx, pref); err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("upsert preference: %w", err))
	}
	return connect.NewResponse(&v1.UpdateNotificationPreferenceResponse{}), nil
}

func (s *notificationService) GetVAPIDPublicKey(
	ctx context.Context,
	_ *connect.Request[v1.GetVAPIDPublicKeyRequest],
) (*connect.Response[v1.GetVAPIDPublicKeyResponse], error) {
	if s.cfg.VAPIDPublicKey == "" {
		return nil, connect.NewError(connect.CodeFailedPrecondition, fmt.Errorf("VAPID not configured"))
	}
	return connect.NewResponse(&v1.GetVAPIDPublicKeyResponse{
		PublicKey: s.cfg.VAPIDPublicKey,
	}), nil
}

// --- NATS consumers ---

// StartConsumers subscribes to device connectivity events and channel delivery events.
func (s *notificationService) StartConsumers(ctx context.Context) error {
	// Track device connections.
	if _, err := s.nc.QueueSubscribe(subjects.DeviceConnectedWildcard(), "notification-workers", func(msg *nats.Msg) {
		parts := strings.Split(msg.Subject, ".")
		if len(parts) < 4 {
			return
		}
		userID := parts[3]
		deviceID := string(msg.Data)
		key := connectedDevicesPrefix + userID
		if err := s.rdb.SAdd(ctx, key, deviceID).Err(); err != nil {
			slog.Error("redis sadd connected device", "err", err, "user", userID)
			return
		}
		// Set TTL so the set expires if the gateway crashes without
		// sending disconnect events (M-8 fix).
		if err := s.rdb.Expire(ctx, key, connectedDevicesTTL).Err(); err != nil {
			slog.Error("redis expire connected devices", "err", err, "user", userID)
		}
	}); err != nil {
		return fmt.Errorf("subscribe device connected: %w", err)
	}

	// Track device disconnections.
	if _, err := s.nc.QueueSubscribe(subjects.DeviceDisconnectedWildcard(), "notification-workers", func(msg *nats.Msg) {
		parts := strings.Split(msg.Subject, ".")
		if len(parts) < 4 {
			return
		}
		userID := parts[3]
		deviceID := string(msg.Data)
		if err := s.rdb.SRem(ctx, connectedDevicesPrefix+userID, deviceID).Err(); err != nil {
			slog.Error("redis srem connected device", "err", err, "user", userID)
		}
	}); err != nil {
		return fmt.Errorf("subscribe device disconnected: %w", err)
	}

	// Refresh connected-devices TTL on heartbeat so the set stays alive
	// while the gateway is healthy (M-8 fix).
	if _, err := s.nc.QueueSubscribe(subjects.PresenceHeartbeatWildcard(), "notification-workers", func(msg *nats.Msg) {
		parts := strings.Split(msg.Subject, ".")
		if len(parts) < 4 {
			return
		}
		userID := parts[3]
		key := connectedDevicesPrefix + userID
		// Only refresh the TTL if the key exists (Expire returns false
		// for missing keys, which is fine — no error to handle).
		if err := s.rdb.Expire(ctx, key, connectedDevicesTTL).Err(); err != nil {
			slog.Error("redis expire heartbeat refresh", "err", err, "user", userID)
		}
	}); err != nil {
		return fmt.Errorf("subscribe presence heartbeat: %w", err)
	}

	// Listen for channel delivery events (same subjects the gateway uses).
	if _, err := s.nc.QueueSubscribe(subjects.DeliverChannelWildcard(), "notification-workers", func(msg *nats.Msg) {
		s.handleChannelEvent(ctx, msg)
	}); err != nil {
		return fmt.Errorf("subscribe channel delivery: %w", err)
	}

	// Listen for device recovery events to push-notify offline devices.
	if _, err := s.nc.QueueSubscribe(subjects.UserRecoveryWildcard(), "notification-workers", func(msg *nats.Msg) {
		s.handleRecoveryEvent(ctx, msg)
	}); err != nil {
		return fmt.Errorf("subscribe user recovery: %w", err)
	}

	slog.Info("notification consumers started")
	return nil
}

// handleChannelEvent processes a channel delivery event and dispatches push
// notifications to offline devices.
func (s *notificationService) handleChannelEvent(ctx context.Context, msg *nats.Msg) {
	parts := strings.Split(msg.Subject, ".")
	if len(parts) < 4 {
		return
	}
	channelID := parts[3]

	var event v1.Event
	if err := proto.Unmarshal(msg.Data, &event); err != nil {
		slog.Error("unmarshal event", "err", err, "channel", channelID)
		return
	}

	// Only process message_create events for now.
	mc, ok := event.Payload.(*v1.Event_MessageCreate)
	if !ok || mc.MessageCreate == nil {
		return
	}

	senderID := mc.MessageCreate.AuthorId
	if senderID == "" {
		return
	}
	// Skip push notifications for system messages.
	if senderID == models.SystemUserID {
		return
	}

	// Resolve channel to get server context.
	channel, err := s.chatStore.GetChannel(ctx, channelID)
	if err != nil {
		slog.Error("get channel for notification", "err", err, "channel", channelID)
		return
	}

	isDM := channel != nil && channel.ServerID == ""
	serverID := ""
	if channel != nil {
		serverID = channel.ServerID
	}

	// DM/group DM channels have at most a few participants; query IDs directly.
	if isDM {
		participantIDs, err := s.chatStore.ListChannelParticipantIDs(ctx, channelID)
		if err != nil {
			slog.Error("list channel participant IDs", "err", err, "channel", channelID)
			return
		}
		// Resolve sender display name once per DM event for the notification Title.
		// E2EE-respecting — display name is public and already returned by
		// GetUserPublicProfile; Body stays generic.
		title := dmTitle(ctx, s.userStore, senderID)
		for _, uid := range participantIDs {
			if uid == senderID {
				continue
			}
			s.notifyOfflineDevices(ctx, uid, pushTrigger{
				Kind:      "dm",
				ChannelID: channelID,
				SenderID:  senderID,
				MessageID: mc.MessageCreate.Id,
				Title:     title,
				Body:      "New message",
			})
		}
		return
	}

	// --- Server channel path: batch queries + async @everyone ---

	// Use the lighter ListMemberUserIDs query (SELECT user_id FROM members)
	// instead of the heavy ListChannelMembers JOIN with users/roles.
	memberIDs, err := s.chatStore.ListMemberUserIDs(ctx, serverID)
	if err != nil {
		slog.Error("list member user IDs", "err", err, "server", serverID)
		return
	}

	// Build a set of explicitly mentioned user IDs for fast lookup.
	mentionedSet := make(map[string]struct{}, len(mc.MessageCreate.MentionedUserIds))
	for _, uid := range mc.MessageCreate.MentionedUserIds {
		mentionedSet[uid] = struct{}{}
	}
	mentionEveryone := mc.MessageCreate.MentionEveryone

	// Rate limit @everyone: max 1 per 60 seconds per server.
	if mentionEveryone && serverID != "" {
		key := fmt.Sprintf("everyone_throttle:%s", serverID)
		set, _ := s.rdb.SetNX(ctx, key, "1", 60*time.Second).Result()
		if !set {
			// Skip @everyone notification processing, but still process
			// individual @user mentions from this message.
			mentionEveryone = false
		}
	}

	// Filter out the sender.
	targetIDs := make([]string, 0, len(memberIDs))
	for _, uid := range memberIDs {
		if uid != senderID {
			targetIDs = append(targetIDs, uid)
		}
	}

	if len(targetIDs) == 0 {
		return
	}

	// Build the trigger template for this server-channel event. The per-user
	// IsMention flag and Body/Title stay constant — IsMention is overridden
	// per target inside processServerNotifications based on mention status.
	base := pushTrigger{
		Kind:      "message",
		ChannelID: channelID,
		SenderID:  senderID,
		MessageID: mc.MessageCreate.Id,
		ServerID:  serverID,
		Title:     "New message",
		Body:      "You have a new message",
	}

	// For @everyone mentions, dispatch asynchronously with bounded concurrency
	// so the NATS handler is not blocked during large fan-outs.
	if mentionEveryone {
		go s.processEveryoneMention(ctx, targetIDs, mentionedSet, base)
		return
	}

	// Non-@everyone: batch the preference query and notify.
	s.processServerNotifications(ctx, targetIDs, mentionedSet, false, base)
}

// processEveryoneMention handles @everyone fan-out asynchronously with
// bounded concurrency, processing users in batches to avoid overwhelming
// the database and Redis.
func (s *notificationService) processEveryoneMention(ctx context.Context, targetIDs []string, mentionedSet map[string]struct{}, base pushTrigger) {
	sem := make(chan struct{}, everyoneConcurrency)
	var wg sync.WaitGroup

	for i := 0; i < len(targetIDs); i += everyoneBatchSize {
		end := i + everyoneBatchSize
		if end > len(targetIDs) {
			end = len(targetIDs)
		}
		batch := targetIDs[i:end]

		wg.Add(1)
		sem <- struct{}{} // Acquire semaphore slot.
		go func(batch []string) {
			defer wg.Done()
			defer func() { <-sem }() // Release semaphore slot.
			s.processServerNotifications(ctx, batch, mentionedSet, true, base)
		}(batch)
	}

	wg.Wait()
	slog.Debug("@everyone fan-out complete", "server", base.ServerID, "channel", base.ChannelID, "users", len(targetIDs))
}

// processServerNotifications resolves notification preferences in bulk and
// dispatches push notifications, using Redis pipelining for device lookups
// and throttle checks. The base trigger carries Kind/SenderID/MessageID/
// ServerID/ChannelID; per-user mention status is layered on top.
func (s *notificationService) processServerNotifications(ctx context.Context, userIDs []string, mentionedSet map[string]struct{}, mentionEveryone bool, base pushTrigger) {
	channelID := base.ChannelID
	serverID := base.ServerID
	if len(userIDs) == 0 {
		return
	}

	// Single batch query for all user preferences instead of per-user queries.
	levels, err := s.prefStore.GetEffectiveLevelsForUsers(ctx, userIDs, serverID, channelID)
	if err != nil {
		slog.Error("get effective levels batch", "err", err, "server", serverID)
		return
	}

	// Classify each user into their push kind based on preference and mention status.
	type pushTarget struct {
		userID    string
		isMention bool // True for both explicit @mention and @everyone targets.
	}
	var targets []pushTarget

	for _, uid := range userIDs {
		level := levels[uid]

		if level == "nothing" {
			continue
		}

		_, isMentioned := mentionedSet[uid]

		if level == "mentions_only" {
			if !isMentioned && !mentionEveryone {
				continue
			}
			targets = append(targets, pushTarget{userID: uid, isMention: true})
			continue
		}

		// level == "all": always notify.
		if isMentioned || mentionEveryone {
			targets = append(targets, pushTarget{userID: uid, isMention: true})
		} else {
			targets = append(targets, pushTarget{userID: uid, isMention: false})
		}
	}

	if len(targets) == 0 {
		return
	}

	// Batch Redis pipeline: fetch connected devices for all target users at once.
	connectedPipe := s.rdb.Pipeline()
	connectedCmds := make([]*redis.StringSliceCmd, len(targets))
	for i, t := range targets {
		connectedCmds[i] = connectedPipe.SMembers(ctx, connectedDevicesPrefix+t.userID)
	}
	if _, err := connectedPipe.Exec(ctx); err != nil && err != redis.Nil {
		slog.Error("redis pipeline smembers", "err", err)
		return
	}

	// Single bulk query for push-enabled devices across all target users.
	targetUserIDs := make([]string, len(targets))
	for i, t := range targets {
		targetUserIDs[i] = t.userID
	}
	allDevices, err := s.deviceStore.GetPushEnabledDevicesForUsers(ctx, targetUserIDs)
	if err != nil {
		slog.Error("get push devices bulk", "err", err, "server", serverID)
		return
	}

	// For each target, resolve connected devices and collect offline devices.
	type offlineTarget struct {
		pushTarget
		devices []*models.Device
	}
	var offlineTargets []offlineTarget

	for i, t := range targets {
		devices := allDevices[t.userID]
		if len(devices) == 0 {
			continue
		}

		connectedIDs, _ := connectedCmds[i].Result()
		connectedSet := make(map[string]bool, len(connectedIDs))
		for _, id := range connectedIDs {
			connectedSet[id] = true
		}

		var offline []*models.Device
		for _, device := range devices {
			if !connectedSet[device.ID] {
				offline = append(offline, device)
			}
		}
		if len(offline) == 0 {
			continue
		}

		offlineTargets = append(offlineTargets, offlineTarget{pushTarget: t, devices: offline})
	}

	if len(offlineTargets) == 0 {
		return
	}

	// Batch Redis pipeline: throttle checks for all offline targets at once.
	// Throttle: 1 push per channel per user per type within the throttle window.
	throttlePipe := s.rdb.Pipeline()
	throttleCmds := make([]*redis.BoolCmd, len(offlineTargets))
	throttleTriggers := make([]pushTrigger, len(offlineTargets))
	for i, ot := range offlineTargets {
		t := base
		t.IsMention = ot.isMention
		throttleTriggers[i] = t
		throttleKey := fmt.Sprintf("push_throttle:%s:%s:%s", t.throttleKeyType(), ot.userID, channelID)
		throttleCmds[i] = throttlePipe.SetNX(ctx, throttleKey, "1", time.Duration(defaultThrottleSeconds)*time.Second)
	}
	if _, err := throttlePipe.Exec(ctx); err != nil && err != redis.Nil {
		slog.Error("redis pipeline setnx throttle", "err", err)
		return
	}

	for i, ot := range offlineTargets {
		set, err := throttleCmds[i].Result()
		if err != nil {
			slog.Error("redis setnx throttle", "err", err, "user", ot.userID)
			continue
		}
		if !set {
			continue // Already sent a push for this channel recently.
		}

		t := throttleTriggers[i]
		for _, device := range ot.devices {
			if err := s.sendPush(ctx, device, t); err != nil {
				slog.Error("send push", "err", err, "user", ot.userID, "device", device.ID, "platform", device.Platform)
			}
		}
	}
}

// notifyOfflineDevices finds push-enabled devices for a user that are not
// currently connected via WebSocket, and dispatches push notifications to them.
// The trigger's Kind/IsMention drives the throttle key namespace ("message",
// "mention", "dm") so distinct push reasons cannot suppress one another.
func (s *notificationService) notifyOfflineDevices(ctx context.Context, userID string, t pushTrigger) {
	// Get all push-enabled devices for this user.
	devices, err := s.deviceStore.GetPushEnabledDevices(ctx, userID)
	if err != nil {
		slog.Error("get push devices", "err", err, "user", userID)
		return
	}
	if len(devices) == 0 {
		return
	}

	// Get connected device IDs from Redis.
	connectedIDs, err := s.rdb.SMembers(ctx, connectedDevicesPrefix+userID).Result()
	if err != nil && err != redis.Nil {
		slog.Error("redis smembers", "err", err, "user", userID)
		return
	}
	connectedSet := make(map[string]bool, len(connectedIDs))
	for _, id := range connectedIDs {
		connectedSet[id] = true
	}

	for _, device := range devices {
		if connectedSet[device.ID] {
			continue // Device is online via WebSocket, skip push.
		}

		// Throttle: 1 push per channel per user per type within the throttle window.
		// Separate key per kind so DM and mention pushes are not suppressed by
		// regular server-channel pushes.
		throttleKey := fmt.Sprintf("push_throttle:%s:%s:%s", t.throttleKeyType(), userID, t.ChannelID)
		throttleSec := defaultThrottleSeconds
		set, err := s.rdb.SetNX(ctx, throttleKey, "1", time.Duration(throttleSec)*time.Second).Result()
		if err != nil {
			slog.Error("redis setnx throttle", "err", err, "user", userID)
			continue
		}
		if !set {
			break // Already sent a push for this channel recently.
		}

		// Dispatch push notification.
		if err := s.sendPush(ctx, device, t); err != nil {
			slog.Error("send push", "err", err, "user", userID, "device", device.ID, "platform", device.Platform)
		}
	}
}

// dmTitle resolves the sender's display name (or username fallback) for use
// as a DM push notification Title. E2EE-respecting — display name is public
// and already returned by GetUserPublicProfile. Returns "Direct message" if
// the lookup fails or no human-readable name is available, so the user still
// gets a usable notification.
func dmTitle(ctx context.Context, store userLooker, senderID string) string {
	const fallback = "Direct message"
	if store == nil {
		return fallback
	}
	user, err := store.GetUserByID(ctx, senderID)
	if err != nil || user == nil {
		slog.Warn("dm push: sender lookup failed, using generic title", "err", err, "sender", senderID)
		return fallback
	}
	if user.DisplayName != "" {
		return user.DisplayName
	}
	if user.Username != "" {
		return user.Username
	}
	return fallback
}

// pushSchemaVersion is the schema version embedded in every push payload so
// future client builds can reason about what fields to expect. Bump only on
// breaking shape changes — additive fields keep the same version.
const pushSchemaVersion = "1"

// pushPayload is the JSON sent inside the push notification.
// The service worker on the client reads this to display the notification.
//
// Field semantics:
//   - Type: "message" (server channel, no mention), "mention" (server channel
//     with mention), "dm" (direct message — 1:1 or group), "device_recovery"
//     (account recovery request). Clients use this to pick the correct pane
//     shape on tap.
//   - UserID: recipient user ID. Clients drop the tap if it does not match
//     the currently signed-in user (multi-account leak prevention).
//   - SenderID / MessageID: enables client-side blocked-user filtering and
//     scroll-to-message UX on tap.
//   - ServerID: populated for server-channel pushes only (empty for DMs).
//   - IsMention: surfaced for the client even for the "dm" Type, so future
//     work can render mention styling without a value-space tweak.
type pushPayload struct {
	V         string `json:"v"`                    // Schema version, currently "1".
	Type      string `json:"type"`                 // See field semantics above.
	ChannelID string `json:"channel_id"`           // Conversation/channel identifier.
	UserID    string `json:"user_id,omitempty"`    // Recipient — for cross-account leak filter.
	SenderID  string `json:"sender_id,omitempty"`
	MessageID string `json:"message_id,omitempty"`
	ServerID  string `json:"server_id,omitempty"`  // Empty for DMs.
	IsMention string `json:"is_mention,omitempty"` // "true" or empty (string for FCM data-map parity).
	Title     string `json:"title"`
	Body      string `json:"body"`
	Tag       string `json:"tag"` // Collapse key — same tag replaces previous notification.
	SessionID string `json:"session_id,omitempty"` // Recovery session identifier.
}

// pushTrigger captures everything needed to build and dispatch a push
// notification for a single (user, conversation) pair: payload contents,
// throttle key inputs, and per-platform render arguments.
type pushTrigger struct {
	Kind      string // "message" | "mention" | "dm" — also used as Type and (for "dm") as tag prefix.
	ChannelID string
	SenderID  string
	MessageID string
	ServerID  string // Empty for DMs.
	IsMention bool
	Title     string
	Body      string
}

// throttleKeyType returns the prefix used for the per-conversation Redis
// throttle key. DMs get their own throttle namespace so a busy server channel
// does not suppress an unrelated DM notification.
func (t pushTrigger) throttleKeyType() string {
	if t.Kind == "dm" {
		return "dm"
	}
	if t.IsMention {
		return "mention"
	}
	return "message"
}

// tag returns the OS-level collapse identifier. Tag namespace splits by Kind
// so DM and channel notifications never collide on tag and the user can mute
// per-conversation cleanly.
func (t pushTrigger) tag() string {
	prefix := "channel"
	if t.Kind == "dm" {
		prefix = "dm"
	}
	return prefix + ":" + t.ChannelID
}

// buildPushPayload assembles the JSON web-push payload for a device + trigger.
// Pure function — exposed for testing.
func buildPushPayload(device *models.Device, t pushTrigger) pushPayload {
	mention := ""
	if t.IsMention {
		mention = "true"
	}
	return pushPayload{
		V:         pushSchemaVersion,
		Type:      t.Kind,
		ChannelID: t.ChannelID,
		UserID:    device.UserID,
		SenderID:  t.SenderID,
		MessageID: t.MessageID,
		ServerID:  t.ServerID,
		IsMention: mention,
		Title:     t.Title,
		Body:      t.Body,
		Tag:       t.tag(),
	}
}

// sendPush dispatches a push notification to a single device.
func (s *notificationService) sendPush(ctx context.Context, device *models.Device, t pushTrigger) error {
	switch device.Platform {
	case "web":
		payload := buildPushPayload(device, t)
		payloadBytes, err := json.Marshal(payload)
		if err != nil {
			return fmt.Errorf("marshal push payload: %w", err)
		}
		return s.sendWebPush(ctx, device, payloadBytes)
	case "android", "ios":
		return s.sendFCMPush(ctx, device, t)
	default:
		return nil
	}
}

// sendWebPush sends a Web Push notification using VAPID.
func (s *notificationService) sendWebPush(ctx context.Context, device *models.Device, payload []byte) error {
	if s.cfg.VAPIDPrivateKey == "" || device.PushEndpoint == "" {
		return nil
	}

	sub := &webpush.Subscription{
		Endpoint: device.PushEndpoint,
		Keys: webpush.Keys{
			P256dh: device.PushP256dh,
			Auth:   device.PushAuth,
		},
	}

	resp, err := webpush.SendNotificationWithContext(ctx, payload, sub, &webpush.Options{
		Subscriber:      s.cfg.VAPIDContact,
		VAPIDPublicKey:  s.cfg.VAPIDPublicKey,
		VAPIDPrivateKey: s.cfg.VAPIDPrivateKey,
		TTL:             3600,
	})
	if err != nil {
		return fmt.Errorf("webpush send: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == 410 {
		// 410 Gone — subscription expired, disable push for this device.
		slog.Info("web push subscription expired, disabling", "user", device.UserID, "device", device.ID)
		device.PushEnabled = false
		if err := s.deviceStore.UpsertDevice(ctx, device); err != nil {
			slog.Error("disable expired push device", "err", err)
		}
		return nil
	}
	if resp.StatusCode >= 400 {
		return fmt.Errorf("webpush HTTP %d", resp.StatusCode)
	}

	slog.Debug("web push sent", "user", device.UserID, "device", device.ID)
	return nil
}

// buildFCMMessage assembles the Firebase Cloud Messaging message for a
// device + trigger. Pure function — exposed for testing the data map and
// per-platform payload shape without making API calls.
func buildFCMMessage(device *models.Device, t pushTrigger) *messaging.Message {
	tag := t.tag()
	data := map[string]string{
		"v":          pushSchemaVersion,
		"type":       t.Kind,
		"channel_id": t.ChannelID,
		"user_id":    device.UserID,
		"tag":        tag,
	}
	if t.SenderID != "" {
		data["sender_id"] = t.SenderID
	}
	if t.MessageID != "" {
		data["message_id"] = t.MessageID
	}
	if t.ServerID != "" {
		data["server_id"] = t.ServerID
	}
	if t.IsMention {
		data["is_mention"] = "true"
	}
	return &messaging.Message{
		Token: device.PushToken,
		Data:  data,
		Android: &messaging.AndroidConfig{
			Priority: "high",
			Notification: &messaging.AndroidNotification{
				Title: t.Title,
				Body:  t.Body,
				Tag:   tag,
			},
		},
		APNS: &messaging.APNSConfig{
			Headers: map[string]string{
				"apns-priority":    "10",
				"apns-collapse-id": tag,
			},
			Payload: &messaging.APNSPayload{
				Aps: &messaging.Aps{
					Alert: &messaging.ApsAlert{
						Title: t.Title,
						Body:  t.Body,
					},
					Sound: "default",
				},
			},
		},
	}
}

// sendFCMPush sends a push notification via Firebase Cloud Messaging.
// Works for both Android (FCM direct) and iOS (FCM proxied to APNs).
func (s *notificationService) sendFCMPush(ctx context.Context, device *models.Device, t pushTrigger) error {
	if s.fcmClient == nil {
		slog.Debug("fcm push skipped (not configured)", "user", device.UserID, "device", device.ID)
		return nil
	}

	msg := buildFCMMessage(device, t)
	_, err := s.fcmClient.Send(ctx, msg)
	if err != nil {
		if messaging.IsUnregistered(err) {
			slog.Info("FCM token unregistered, disabling push", "user", device.UserID, "device", device.ID)
			device.PushEnabled = false
			if dbErr := s.deviceStore.UpsertDevice(ctx, device); dbErr != nil {
				slog.Error("disable unregistered FCM device", "err", dbErr)
			}
			return nil
		}
		return fmt.Errorf("fcm send: %w", err)
	}

	slog.Debug("FCM push sent", "user", device.UserID, "device", device.ID, "platform", device.Platform)
	return nil
}

// handleRecoveryEvent processes device recovery request events and sends
// push notifications to the user's offline devices.
func (s *notificationService) handleRecoveryEvent(ctx context.Context, msg *nats.Msg) {
	// Extract userID from subject: meza.user.recovery.<userID>
	parts := strings.Split(msg.Subject, ".")
	if len(parts) < 4 {
		return
	}
	userID := parts[3]

	// Parse the event to get session_id for the push payload.
	var event v1.Event
	if err := proto.Unmarshal(msg.Data, &event); err != nil {
		slog.Error("unmarshal recovery event", "err", err)
		return
	}
	recoveryEvent := event.GetDeviceRecoveryRequest()
	if recoveryEvent == nil {
		return
	}

	// Get all push-enabled devices for this user.
	devices, err := s.deviceStore.GetPushEnabledDevices(ctx, userID)
	if err != nil {
		slog.Error("get push devices for recovery", "err", err, "user", userID)
		return
	}
	if len(devices) == 0 {
		return
	}

	// Get connected device IDs from Redis.
	connectedIDs, err := s.rdb.SMembers(ctx, connectedDevicesPrefix+userID).Result()
	if err != nil && err != redis.Nil {
		slog.Error("redis smembers for recovery", "err", err, "user", userID)
		return
	}
	connectedSet := make(map[string]bool, len(connectedIDs))
	for _, id := range connectedIDs {
		connectedSet[id] = true
	}

	for _, device := range devices {
		if connectedSet[device.ID] {
			continue // Device is online via WebSocket, skip push.
		}

		// Throttle: 1 push per recovery session per user.
		throttleKey := fmt.Sprintf("push_throttle:device_recovery:%s:%s", userID, recoveryEvent.SessionId)
		set, err := s.rdb.SetNX(ctx, throttleKey, "1", 5*time.Minute).Result()
		if err != nil {
			slog.Error("redis setnx recovery throttle", "err", err, "user", userID)
			continue
		}
		if !set {
			break // Already sent for this recovery session.
		}

		// Send recovery-specific push notification.
		if err := s.sendRecoveryPush(ctx, device, recoveryEvent.SessionId); err != nil {
			slog.Error("send recovery push", "err", err, "user", userID, "device", device.ID)
		}
	}
}

// sendRecoveryPush sends a push notification for a device recovery request.
func (s *notificationService) sendRecoveryPush(ctx context.Context, device *models.Device, sessionID string) error {
	payload := pushPayload{
		V:         pushSchemaVersion,
		Type:      "device_recovery",
		UserID:    device.UserID,
		Title:     "Account Recovery Request",
		Body:      "Another device is requesting access to your account",
		SessionID: sessionID,
	}
	payloadBytes, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("marshal recovery push payload: %w", err)
	}

	switch device.Platform {
	case "web":
		return s.sendWebPush(ctx, device, payloadBytes)
	case "android", "ios":
		return s.sendFCMRecoveryPush(ctx, device, sessionID)
	default:
		return nil
	}
}

// sendFCMRecoveryPush sends a recovery push notification via Firebase Cloud Messaging.
func (s *notificationService) sendFCMRecoveryPush(ctx context.Context, device *models.Device, sessionID string) error {
	if s.fcmClient == nil {
		slog.Debug("fcm recovery push skipped (not configured)", "user", device.UserID, "device", device.ID)
		return nil
	}

	msg := &messaging.Message{
		Token: device.PushToken,
		Data: map[string]string{
			"v":          pushSchemaVersion,
			"type":       "device_recovery",
			"user_id":    device.UserID,
			"session_id": sessionID,
		},
		Android: &messaging.AndroidConfig{
			Priority: "high",
			Notification: &messaging.AndroidNotification{
				Title: "Account Recovery Request",
				Body:  "Another device is requesting access to your account",
				Tag:   "device_recovery:" + sessionID,
			},
		},
		APNS: &messaging.APNSConfig{
			Headers: map[string]string{
				"apns-priority":    "10",
				"apns-collapse-id": "device_recovery:" + sessionID,
			},
			Payload: &messaging.APNSPayload{
				Aps: &messaging.Aps{
					Alert: &messaging.ApsAlert{
						Title: "Account Recovery Request",
						Body:  "Another device is requesting access to your account",
					},
					Sound: "default",
				},
			},
		},
	}

	_, err := s.fcmClient.Send(ctx, msg)
	if err != nil {
		if messaging.IsUnregistered(err) {
			slog.Info("FCM token unregistered, disabling push", "user", device.UserID, "device", device.ID)
			device.PushEnabled = false
			if dbErr := s.deviceStore.UpsertDevice(ctx, device); dbErr != nil {
				slog.Error("disable unregistered FCM device", "err", dbErr)
			}
			return nil
		}
		return fmt.Errorf("fcm send recovery: %w", err)
	}

	slog.Debug("FCM recovery push sent", "user", device.UserID, "device", device.ID, "platform", device.Platform)
	return nil
}

