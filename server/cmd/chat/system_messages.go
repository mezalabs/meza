package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	"github.com/nats-io/nats.go"
	"google.golang.org/protobuf/proto"

	v1 "github.com/meza-chat/meza/gen/meza/v1"
	"github.com/meza-chat/meza/internal/models"
	"github.com/meza-chat/meza/internal/subjects"
)

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
