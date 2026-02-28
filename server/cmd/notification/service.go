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
	"github.com/nats-io/nats.go"
	"github.com/redis/go-redis/v9"
	"google.golang.org/protobuf/proto"

	v1 "github.com/meza-chat/meza/gen/meza/v1"
	"github.com/meza-chat/meza/internal/auth"
	"github.com/meza-chat/meza/internal/config"
	"github.com/meza-chat/meza/internal/models"
	"github.com/meza-chat/meza/internal/store"
	"github.com/meza-chat/meza/internal/subjects"
)

const (
	// Redis key prefix for tracking connected devices per user.
	connectedDevicesPrefix = "connected_devices:"

	// Default throttle window: 1 push per 30s per channel per user.
	defaultThrottleSeconds = 30

	// everyoneBatchSize is the number of users processed per batch when
	// fan-out notifying @everyone mentions.
	everyoneBatchSize = 300

	// everyoneConcurrency is the max number of goroutines processing
	// @everyone batches concurrently.
	everyoneConcurrency = 8
)

type notificationService struct {
	deviceStore store.DeviceStorer
	prefStore   store.NotificationPreferenceStorer
	chatStore   store.ChatStorer
	rdb         *redis.Client
	nc          *nats.Conn
	cfg         *config.Config
}

func newNotificationService(
	deviceStore store.DeviceStorer,
	prefStore store.NotificationPreferenceStorer,
	chatStore store.ChatStorer,
	rdb *redis.Client,
	nc *nats.Conn,
	cfg *config.Config,
) *notificationService {
	return &notificationService{
		deviceStore: deviceStore,
		prefStore:   prefStore,
		chatStore:   chatStore,
		rdb:         rdb,
		nc:          nc,
		cfg:         cfg,
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
		if err := s.rdb.SAdd(ctx, connectedDevicesPrefix+userID, deviceID).Err(); err != nil {
			slog.Error("redis sadd connected device", "err", err, "user", userID)
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

	// Listen for channel delivery events (same subjects the gateway uses).
	if _, err := s.nc.QueueSubscribe(subjects.DeliverChannelWildcard(), "notification-workers", func(msg *nats.Msg) {
		s.handleChannelEvent(ctx, msg)
	}); err != nil {
		return fmt.Errorf("subscribe channel delivery: %w", err)
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
		for _, uid := range participantIDs {
			if uid == senderID {
				continue
			}
			s.notifyOfflineDevices(ctx, uid, channelID, "message")
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

	// For @everyone mentions, dispatch asynchronously with bounded concurrency
	// so the NATS handler is not blocked during large fan-outs.
	if mentionEveryone {
		go s.processEveryoneMention(ctx, targetIDs, mentionedSet, serverID, channelID)
		return
	}

	// Non-@everyone: batch the preference query and notify.
	s.processServerNotifications(ctx, targetIDs, mentionedSet, false, serverID, channelID)
}

// processEveryoneMention handles @everyone fan-out asynchronously with
// bounded concurrency, processing users in batches to avoid overwhelming
// the database and Redis.
func (s *notificationService) processEveryoneMention(ctx context.Context, targetIDs []string, mentionedSet map[string]struct{}, serverID, channelID string) {
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
			s.processServerNotifications(ctx, batch, mentionedSet, true, serverID, channelID)
		}(batch)
	}

	wg.Wait()
	slog.Debug("@everyone fan-out complete", "server", serverID, "channel", channelID, "users", len(targetIDs))
}

// processServerNotifications resolves notification preferences in bulk and
// dispatches push notifications, using Redis pipelining for device lookups
// and throttle checks.
func (s *notificationService) processServerNotifications(ctx context.Context, userIDs []string, mentionedSet map[string]struct{}, mentionEveryone bool, serverID, channelID string) {
	if len(userIDs) == 0 {
		return
	}

	// Single batch query for all user preferences instead of per-user queries.
	levels, err := s.prefStore.GetEffectiveLevelsForUsers(ctx, userIDs, serverID, channelID)
	if err != nil {
		slog.Error("get effective levels batch", "err", err, "server", serverID)
		return
	}

	// Classify each user into their push type based on preference and mention status.
	type pushTarget struct {
		userID   string
		pushType string // "message" or "mention"
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
			targets = append(targets, pushTarget{userID: uid, pushType: "mention"})
			continue
		}

		// level == "all": always notify.
		if isMentioned || mentionEveryone {
			targets = append(targets, pushTarget{userID: uid, pushType: "mention"})
		} else {
			targets = append(targets, pushTarget{userID: uid, pushType: "message"})
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

	// For each target, get their push-enabled devices and send pushes to offline ones.
	for i, t := range targets {
		devices, err := s.deviceStore.GetPushEnabledDevices(ctx, t.userID)
		if err != nil {
			slog.Error("get push devices", "err", err, "user", t.userID)
			continue
		}
		if len(devices) == 0 {
			continue
		}

		connectedIDs, _ := connectedCmds[i].Result()
		connectedSet := make(map[string]bool, len(connectedIDs))
		for _, id := range connectedIDs {
			connectedSet[id] = true
		}

		// Pipeline throttle checks for this user's offline devices.
		var offlineDevices []*models.Device
		for _, device := range devices {
			if !connectedSet[device.ID] {
				offlineDevices = append(offlineDevices, device)
			}
		}
		if len(offlineDevices) == 0 {
			continue
		}

		// Throttle: 1 push per channel per user per type within the throttle window.
		throttleKey := fmt.Sprintf("push_throttle:%s:%s:%s", t.pushType, t.userID, channelID)
		set, err := s.rdb.SetNX(ctx, throttleKey, "1", time.Duration(defaultThrottleSeconds)*time.Second).Result()
		if err != nil {
			slog.Error("redis setnx throttle", "err", err, "user", t.userID)
			continue
		}
		if !set {
			continue // Already sent a push for this channel recently.
		}

		for _, device := range offlineDevices {
			if err := s.sendPush(ctx, device, channelID); err != nil {
				slog.Error("send push", "err", err, "user", t.userID, "device", device.ID, "platform", device.Platform)
			}
		}
	}
}

// notifyOfflineDevices finds push-enabled devices for a user that are not
// currently connected via WebSocket, and dispatches push notifications to them.
// pushType differentiates throttle keys: "message" for regular pushes, "mention"
// for mention pushes, preventing mention notifications from being suppressed by
// regular message throttling.
func (s *notificationService) notifyOfflineDevices(ctx context.Context, userID, channelID, pushType string) {
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
		// Separate key for mentions so they aren't suppressed by regular pushes.
		throttleKey := fmt.Sprintf("push_throttle:%s:%s:%s", pushType, userID, channelID)
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
		if err := s.sendPush(ctx, device, channelID); err != nil {
			slog.Error("send push", "err", err, "user", userID, "device", device.ID, "platform", device.Platform)
		}
	}
}

// pushPayload is the JSON sent inside the push notification.
// The service worker on the client reads this to display the notification.
type pushPayload struct {
	Type      string `json:"type"`       // "message", "mention", "dm", etc.
	ChannelID string `json:"channel_id"` // For navigation on click.
	Title     string `json:"title"`
	Body      string `json:"body"`
	Tag       string `json:"tag"` // Collapse key — same tag replaces previous notification.
}

// sendPush dispatches a push notification to a single device.
func (s *notificationService) sendPush(ctx context.Context, device *models.Device, channelID string) error {
	payload := pushPayload{
		Type:      "message",
		ChannelID: channelID,
		Title:     "New message",
		Body:      "You have a new message", // Generic — E2EE means no content in push.
		Tag:       "channel:" + channelID,
	}
	payloadBytes, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("marshal push payload: %w", err)
	}

	switch device.Platform {
	case "web":
		return s.sendWebPush(ctx, device, payloadBytes)
	case "android":
		// FCM integration — placeholder for future phase.
		slog.Info("fcm push skipped (not yet implemented)", "user", device.UserID, "device", device.ID)
		return nil
	case "ios":
		// APNs integration — placeholder for future phase.
		slog.Info("apns push skipped (not yet implemented)", "user", device.UserID, "device", device.ID)
		return nil
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

