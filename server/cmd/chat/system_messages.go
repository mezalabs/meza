package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	"github.com/nats-io/nats.go"
	"google.golang.org/protobuf/proto"

	v1 "github.com/mezalabs/meza/gen/meza/v1"
	"github.com/mezalabs/meza/internal/models"
	"github.com/mezalabs/meza/internal/subjects"
)

// cachedSystemMessageConfig wraps a config with expiry for in-process caching.
type cachedSystemMessageConfig struct {
	config    *models.ServerSystemMessageConfig // nil means no config row
	expiresAt time.Time
}

const systemMessageConfigCacheTTL = 5 * time.Minute

// getSystemMessageConfigCached loads config from cache or DB.
func (s *chatService) getSystemMessageConfigCached(ctx context.Context, serverID string) *models.ServerSystemMessageConfig {
	if val, ok := s.systemMessageConfigCache.Load(serverID); ok {
		cached := val.(*cachedSystemMessageConfig)
		if time.Now().Before(cached.expiresAt) {
			return cached.config
		}
		s.systemMessageConfigCache.Delete(serverID)
	}
	cfg, err := s.chatStore.GetSystemMessageConfig(ctx, serverID)
	if err != nil {
		slog.Warn("failed to load system message config, using defaults", "server", serverID, "err", err)
		return nil
	}
	s.systemMessageConfigCache.Store(serverID, &cachedSystemMessageConfig{
		config:    cfg,
		expiresAt: time.Now().Add(systemMessageConfigCacheTTL),
	})
	return cfg
}

// publishSystemMessage creates a system message, persists it, and delivers it
// via NATS. The content parameter must be one of the typed content structs
// (MemberEventContent, MemberKickContent, ChannelUpdateContent, KeyRotationContent).
func (s *chatService) publishSystemMessage(ctx context.Context, channelID string, msgType uint32, content any) error {
	contentBytes, err := json.Marshal(content)
	if err != nil {
		slog.Error("failed to marshal system message content",
			"channel_id", channelID, "type", msgType, "error", err)
		return fmt.Errorf("marshal system message: %w", err)
	}

	// Rate limit: at most 1 system message per type per 5 seconds per channel.
	// Uses a Lua script to atomically INCR and set TTL on first increment,
	// preventing orphaned keys if the process crashes between INCR and EXPIRE.
	rateKey := fmt.Sprintf("sys_msg_rate:%s:%d", channelID, msgType)
	rateLimitScript := `local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return count`
	count, err := s.rdb.Eval(ctx, rateLimitScript, []string{rateKey}, 5).Int64()
	if err != nil {
		slog.Warn("system message rate limit check failed, allowing message", "key", rateKey, "err", err)
	} else if count > 1 {
		return nil // suppress duplicate within rate window
	}

	msg := &models.Message{
		ChannelID:        channelID,
		MessageID:        models.NewID(),
		AuthorID:         models.SystemUserID,
		EncryptedContent: contentBytes,
		KeyVersion:       0,
		Type:             msgType,
		CreatedAt:        time.Now(),
	}
	if err := s.messageStore.InsertMessage(ctx, msg); err != nil {
		slog.Error("failed to insert system message",
			"channel_id", channelID, "type", msgType, "error", err)
		return fmt.Errorf("insert system message: %w", err)
	}

	event := &v1.Event{
		Type: v1.EventType_EVENT_TYPE_MESSAGE_CREATE,
		Payload: &v1.Event_MessageCreate{
			MessageCreate: messageToProto(msg, nil),
		},
	}
	eventBytes, err := proto.Marshal(event)
	if err != nil {
		slog.Error("failed to marshal system message event",
			"channel_id", channelID, "type", msgType, "error", err)
		return fmt.Errorf("marshal system message event: %w", err)
	}
	if err := s.nc.Publish(subjects.DeliverChannel(channelID), eventBytes); err != nil {
		slog.Error("failed to publish system message",
			"channel_id", channelID, "type", msgType, "error", err)
		return err
	}
	return nil
}

// publishServerSystemMessage resolves the target channel from config (or default),
// checks if the event is enabled, applies custom templates, and publishes.
// eventAction is "join", "leave", "kick", "ban", or "timeout".
func (s *chatService) publishServerSystemMessage(ctx context.Context, serverID string, msgType uint32, eventAction string, content any, templateVars map[string]string) {
	cfg := s.getSystemMessageConfigCached(ctx, serverID)

	// Check if event is enabled.
	if cfg != nil && !isEventEnabled(cfg, eventAction) {
		return
	}

	// Resolve target channel.
	channelID := resolveChannelID(cfg, eventAction)
	if channelID == "" {
		// Fall back to default text channel.
		ch, err := s.getDefaultTextChannel(ctx, serverID)
		if err != nil || ch == nil {
			if err != nil {
				slog.Warn("system message: failed to get default channel", "server", serverID, "err", err)
			}
			return
		}
		channelID = ch.ID
	}

	// Apply custom template if configured.
	tmpl := getTemplate(cfg, eventAction)
	if tmpl != "" {
		rendered := renderTemplate(tmpl, templateVars)
		// Wrap content with rendered field by marshaling, adding rendered, re-wrapping.
		contentBytes, _ := json.Marshal(content)
		var contentMap map[string]any
		if err := json.Unmarshal(contentBytes, &contentMap); err == nil {
			contentMap["rendered"] = rendered
			content = contentMap
		}
	}

	if err := s.publishSystemMessage(ctx, channelID, msgType, content); err != nil {
		slog.Warn("system message failed", "server", serverID, "action", eventAction, "err", err)
	}
}

func isEventEnabled(cfg *models.ServerSystemMessageConfig, action string) bool {
	switch action {
	case "join":
		return cfg.JoinEnabled
	case "leave":
		return cfg.LeaveEnabled
	case "kick":
		return cfg.KickEnabled
	case "ban":
		return cfg.BanEnabled
	case "timeout":
		return cfg.TimeoutEnabled
	default:
		return true
	}
}

func resolveChannelID(cfg *models.ServerSystemMessageConfig, action string) string {
	if cfg == nil {
		return ""
	}
	switch action {
	case "join", "leave":
		if cfg.WelcomeChannelID != nil {
			return *cfg.WelcomeChannelID
		}
	case "kick", "ban", "timeout":
		if cfg.ModLogChannelID != nil {
			return *cfg.ModLogChannelID
		}
	}
	return ""
}

func getTemplate(cfg *models.ServerSystemMessageConfig, action string) string {
	if cfg == nil {
		return ""
	}
	switch action {
	case "join":
		if cfg.JoinTemplate != nil {
			return *cfg.JoinTemplate
		}
	case "leave":
		if cfg.LeaveTemplate != nil {
			return *cfg.LeaveTemplate
		}
	case "kick":
		if cfg.KickTemplate != nil {
			return *cfg.KickTemplate
		}
	case "ban":
		if cfg.BanTemplate != nil {
			return *cfg.BanTemplate
		}
	case "timeout":
		if cfg.TimeoutTemplate != nil {
			return *cfg.TimeoutTemplate
		}
	}
	return ""
}

// getDefaultTextChannel returns the first public, default, text channel for a server.
// Returns nil if no suitable channel exists.
func (s *chatService) getDefaultTextChannel(ctx context.Context, serverID string) (*models.Channel, error) {
	channels, err := s.chatStore.GetDefaultChannels(ctx, serverID)
	if err != nil {
		return nil, err
	}
	for _, ch := range channels {
		if ch.Type == 1 { // CHANNEL_TYPE_TEXT
			return ch, nil
		}
	}
	return nil, nil
}

// resolveDisplayName returns the best display name for a user in a server context.
// Priority: member nickname > user display name > username.
func (s *chatService) resolveDisplayName(ctx context.Context, userID, serverID string) string {
	member, err := s.chatStore.GetMember(ctx, userID, serverID)
	if err == nil && member != nil && member.Nickname != "" {
		return member.Nickname
	}
	if s.authStore == nil {
		return userID
	}
	user, err := s.authStore.GetUserByID(ctx, userID)
	if err == nil && user != nil {
		if user.DisplayName != "" {
			return user.DisplayName
		}
		return user.Username
	}
	return userID // fallback to raw ID
}

// subscribeKeyRotation sets up a NATS QueueSubscribe for internal key rotation
// events published by the keys service. Each event triggers a system message
// in the rotated channel.
func (s *chatService) subscribeKeyRotation() (*nats.Subscription, error) {
	return s.nc.QueueSubscribe(subjects.InternalKeyRotation(), "chat-key-rotation", func(msg *nats.Msg) {
		var event v1.KeyRotationInternalEvent
		if err := proto.Unmarshal(msg.Data, &event); err != nil {
			slog.Error("unmarshal key rotation event", "err", err)
			return
		}
		if event.ChannelId == "" || event.NewKeyVersion == 0 {
			slog.Warn("invalid key rotation event", "channel_id", event.ChannelId, "version", event.NewKeyVersion)
			return
		}

		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()

		if err := s.publishSystemMessage(ctx, event.ChannelId, uint32(v1.MessageType_MESSAGE_TYPE_KEY_ROTATION), KeyRotationContent{
			ActorID:       event.ActorId,
			NewKeyVersion: event.NewKeyVersion,
		}); err != nil {
			slog.Warn("system message: key rotation failed", "channel", event.ChannelId, "err", err)
		}
	})
}
