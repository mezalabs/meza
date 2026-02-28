package main

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/meza-chat/meza/gen/meza/v1"
	"github.com/meza-chat/meza/internal/auth"
	"github.com/meza-chat/meza/internal/embed"
	"github.com/meza-chat/meza/internal/models"
	"github.com/meza-chat/meza/internal/permissions"
	"github.com/meza-chat/meza/internal/subjects"
)

func (s *chatService) PinMessage(ctx context.Context, req *connect.Request[v1.PinMessageRequest]) (*connect.Response[v1.PinMessageResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing user"))
	}
	if req.Msg.ChannelId == "" || req.Msg.MessageId == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("channel_id and message_id are required"))
	}

	// Verify channel exists and user is a member.
	ch, isMember, err := s.chatStore.GetChannelAndCheckMembership(ctx, req.Msg.ChannelId, userID)
	if err != nil {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("channel not found"))
	}
	if !isMember {
		return nil, connect.NewError(connect.CodePermissionDenied, errors.New("not a member of this server"))
	}

	// Fetch the message and verify it exists and is not deleted.
	msg, err := s.messageStore.GetMessage(ctx, req.Msg.ChannelId, req.Msg.MessageId)
	if err != nil {
		slog.Error("getting message for pin", "err", err, "user", userID, "channel", req.Msg.ChannelId)
		return nil, connect.NewError(connect.CodeNotFound, errors.New("message not found"))
	}
	if msg.Deleted {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("message not found"))
	}

	// Permission: message author can always pin own messages;
	// otherwise need ManageMessages permission (channel-scoped with overrides).
	if msg.AuthorID != userID {
		if ch.ServerID != "" {
			perms, permErr := s.resolvePermissions(ctx, userID, ch.ServerID, ch.ID)
			if permErr != nil {
				return nil, permErr
			}
			if !permissions.Has(perms, permissions.ManageMessages) {
				return nil, connect.NewError(connect.CodePermissionDenied, errors.New("missing permission"))
			}
		}
	}

	// Pin the message (idempotent: ON CONFLICT DO NOTHING).
	if err := s.pinStore.PinMessage(ctx, req.Msg.ChannelId, req.Msg.MessageId, userID); err != nil {
		slog.Error("pinning message", "err", err, "user", userID, "channel", req.Msg.ChannelId)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	now := time.Now()
	pinnedMsg := &v1.PinnedMessage{
		Message:  messageToProto(msg, nil),
		PinnedBy: userID,
		PinnedAt: timestamppb.New(now),
	}

	// Broadcast PIN_ADD event.
	event := &v1.Event{
		Id:        models.NewID(),
		Type:      v1.EventType_EVENT_TYPE_PIN_ADD,
		Timestamp: timestamppb.New(now),
		Payload:   &v1.Event_PinAdd{PinAdd: pinnedMsg},
	}
	eventData, err := proto.Marshal(event)
	if err != nil {
		slog.Error("marshaling event", "err", err)
	} else {
		s.nc.Publish(subjects.DeliverChannel(req.Msg.ChannelId), eventData)
	}

	return connect.NewResponse(&v1.PinMessageResponse{
		PinnedMessage: pinnedMsg,
	}), nil
}

func (s *chatService) UnpinMessage(ctx context.Context, req *connect.Request[v1.UnpinMessageRequest]) (*connect.Response[v1.UnpinMessageResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing user"))
	}
	if req.Msg.ChannelId == "" || req.Msg.MessageId == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("channel_id and message_id are required"))
	}

	ch, isMember, err := s.chatStore.GetChannelAndCheckMembership(ctx, req.Msg.ChannelId, userID)
	if err != nil {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("channel not found"))
	}
	if !isMember {
		return nil, connect.NewError(connect.CodePermissionDenied, errors.New("not a member of this server"))
	}

	// Verify message is pinned.
	pinned, err := s.pinStore.IsPinned(ctx, req.Msg.ChannelId, req.Msg.MessageId)
	if err != nil {
		slog.Error("checking pin status", "err", err, "channel", req.Msg.ChannelId)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}
	if !pinned {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("message is not pinned"))
	}

	// Permission: message author can unpin own messages;
	// otherwise need ManageMessages permission.
	msg, err := s.messageStore.GetMessage(ctx, req.Msg.ChannelId, req.Msg.MessageId)
	if err != nil {
		slog.Error("getting message for unpin", "err", err, "user", userID, "channel", req.Msg.ChannelId)
		return nil, connect.NewError(connect.CodeNotFound, errors.New("message not found"))
	}

	if msg.AuthorID != userID {
		if ch.ServerID != "" {
			perms, permErr := s.resolvePermissions(ctx, userID, ch.ServerID, ch.ID)
			if permErr != nil {
				return nil, permErr
			}
			if !permissions.Has(perms, permissions.ManageMessages) {
				return nil, connect.NewError(connect.CodePermissionDenied, errors.New("missing permission"))
			}
		}
	}

	if err := s.pinStore.UnpinMessage(ctx, req.Msg.ChannelId, req.Msg.MessageId); err != nil {
		slog.Error("unpinning message", "err", err, "user", userID, "channel", req.Msg.ChannelId)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	// Broadcast PIN_REMOVE event.
	event := &v1.Event{
		Id:        models.NewID(),
		Type:      v1.EventType_EVENT_TYPE_PIN_REMOVE,
		Timestamp: timestamppb.New(time.Now()),
		Payload: &v1.Event_PinRemove{PinRemove: &v1.PinRemoveEvent{
			ChannelId: req.Msg.ChannelId,
			MessageId: req.Msg.MessageId,
		}},
	}
	eventData, err := proto.Marshal(event)
	if err != nil {
		slog.Error("marshaling event", "err", err)
	} else {
		s.nc.Publish(subjects.DeliverChannel(req.Msg.ChannelId), eventData)
	}

	return connect.NewResponse(&v1.UnpinMessageResponse{}), nil
}

func (s *chatService) GetPinnedMessages(ctx context.Context, req *connect.Request[v1.GetPinnedMessagesRequest]) (*connect.Response[v1.GetPinnedMessagesResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing user"))
	}
	if req.Msg.ChannelId == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("channel_id is required"))
	}

	_, isMember, err := s.chatStore.GetChannelAndCheckMembership(ctx, req.Msg.ChannelId, userID)
	if err != nil {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("channel not found"))
	}
	if !isMember {
		return nil, connect.NewError(connect.CodePermissionDenied, errors.New("not a member"))
	}

	// Parse cursor: default to now() for first page.
	before := time.Now()
	if req.Msg.Before != "" {
		parsed, parseErr := time.Parse(time.RFC3339Nano, req.Msg.Before)
		if parseErr != nil {
			return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("invalid before cursor"))
		}
		before = parsed
	}

	limit := int(req.Msg.Limit)
	if limit <= 0 {
		limit = 50
	}
	if limit > 100 {
		limit = 100
	}

	// Fetch limit+1 to detect hasMore.
	pins, err := s.pinStore.GetPinnedMessages(ctx, req.Msg.ChannelId, before, limit+1)
	if err != nil {
		slog.Error("getting pinned messages", "err", err, "user", userID, "channel", req.Msg.ChannelId)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	hasMore := len(pins) > limit
	if hasMore {
		pins = pins[:limit]
	}

	// Batch-fetch full messages from ScyllaDB.
	messageIDs := make([]string, 0, len(pins))
	for _, pin := range pins {
		messageIDs = append(messageIDs, pin.MessageID)
	}
	messages, err := s.messageStore.GetMessagesByIDs(ctx, req.Msg.ChannelId, messageIDs)
	if err != nil {
		slog.Error("batch fetching messages for pins", "err", err, "channel", req.Msg.ChannelId)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	// Build response, skipping orphaned pins.
	protoPins := make([]*v1.PinnedMessage, 0, len(pins))
	for _, pin := range pins {
		msg, ok := messages[pin.MessageID]
		if !ok || msg.Deleted {
			// Orphaned pin — best-effort cleanup.
			_ = s.pinStore.UnpinMessage(ctx, pin.ChannelID, pin.MessageID)
			continue
		}

		pinnedBy := ""
		if pin.PinnedBy != nil {
			pinnedBy = *pin.PinnedBy
		}

		protoPins = append(protoPins, &v1.PinnedMessage{
			Message:  messageToProto(msg, nil),
			PinnedBy: pinnedBy,
			PinnedAt: timestamppb.New(pin.PinnedAt),
		})
	}

	// Hydrate link embeds for pinned messages.
	if len(messageIDs) > 0 && s.linkPreviewStore != nil {
		embedMap, embedErr := s.linkPreviewStore.GetEmbedsForMessages(ctx, req.Msg.ChannelId, messageIDs)
		if embedErr != nil {
			slog.Error("hydrating embeds for pinned messages", "err", embedErr, "channel", req.Msg.ChannelId)
		} else {
			for _, pp := range protoPins {
				if previews, ok := embedMap[pp.Message.Id]; ok {
					pp.Message.Embeds = embed.LinkPreviewsToProto(previews)
				}
			}
		}
	}

	return connect.NewResponse(&v1.GetPinnedMessagesResponse{
		PinnedMessages: protoPins,
		HasMore:        hasMore,
	}), nil
}

// messageToProto converts a models.Message to a proto Message.
// attachments may be nil when attachment data is not available.
func messageToProto(msg *models.Message, attachments []*v1.Attachment) *v1.Message {
	protoMsg := &v1.Message{
		Id:               msg.MessageID,
		ChannelId:        msg.ChannelID,
		AuthorId:         msg.AuthorID,
		EncryptedContent: msg.EncryptedContent,
		Attachments:      attachments,
		CreatedAt:        timestamppb.New(msg.CreatedAt),
	}
	if !msg.EditedAt.IsZero() {
		protoMsg.EditedAt = timestamppb.New(msg.EditedAt)
	}
	if msg.ReplyToID != "" {
		protoMsg.ReplyToId = &msg.ReplyToID
	}
	protoMsg.MentionedUserIds = msg.MentionedUserIDs
	protoMsg.MentionedRoleIds = msg.MentionedRoleIDs
	protoMsg.MentionEveryone = msg.MentionEveryone
	protoMsg.KeyVersion = msg.KeyVersion
	return protoMsg
}
