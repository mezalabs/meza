package main

import (
	"context"
	"errors"
	"log/slog"
	"regexp"
	"strings"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/meza-chat/meza/gen/meza/v1"
	"github.com/meza-chat/meza/internal/auth"
	"github.com/meza-chat/meza/internal/models"
	"github.com/meza-chat/meza/internal/permissions"
	"github.com/meza-chat/meza/internal/subjects"
)

const (
	maxPersonalEmojis = 10
	maxServerEmojis   = 20
)

var emojiNameRe = regexp.MustCompile(`^[a-z0-9_]{2,32}$`)

func (s *chatService) CreateEmoji(ctx context.Context, req *connect.Request[v1.CreateEmojiRequest]) (*connect.Response[v1.CreateEmojiResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing user"))
	}
	if req.Msg.Name == "" || req.Msg.AttachmentId == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("name and attachment_id are required"))
	}
	if !emojiNameRe.MatchString(req.Msg.Name) {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("name must be 2-32 lowercase alphanumeric or underscore characters"))
	}

	isServerEmoji := req.Msg.ServerId != ""

	if isServerEmoji {
		if err := s.requireMembership(ctx, userID, req.Msg.ServerId); err != nil {
			return nil, err
		}
		perms, permErr := s.resolvePermissions(ctx, userID, req.Msg.ServerId, "")
		if permErr != nil {
			return nil, permErr
		}
		if !permissions.Has(perms, permissions.ManageEmojis) {
			return nil, connect.NewError(connect.CodePermissionDenied, errors.New("missing permission"))
		}
	}

	emoji := &models.Emoji{
		ID:           models.NewID(),
		ServerID:     req.Msg.ServerId,
		UserID:       userID,
		Name:         req.Msg.Name,
		AttachmentID: req.Msg.AttachmentId,
		CreatorID:    userID,
		CreatedAt:    time.Now(),
	}

	created, err := s.emojiStore.CreateEmoji(ctx, emoji, maxPersonalEmojis, maxServerEmojis)
	if err != nil {
		if strings.Contains(err.Error(), "duplicate key") || strings.Contains(err.Error(), "unique constraint") {
			return nil, connect.NewError(connect.CodeAlreadyExists, errors.New("an emoji with this name already exists"))
		}
		slog.Error("creating emoji", "err", err, "user", userID, "server", req.Msg.ServerId)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}
	if created == nil {
		return nil, connect.NewError(connect.CodeResourceExhausted, errors.New("emoji limit reached or attachment not valid"))
	}

	// Broadcast event for server emojis only.
	if isServerEmoji {
		event := &v1.Event{
			Id:        models.NewID(),
			Type:      v1.EventType_EVENT_TYPE_EMOJI_CREATE,
			Timestamp: timestamppb.New(time.Now()),
			Payload: &v1.Event_EmojiCreate{
				EmojiCreate: emojiToProto(created),
			},
		}
		if data, err := proto.Marshal(event); err != nil {
			slog.Error("marshaling event", "err", err)
		} else {
			s.nc.Publish(subjects.ServerEmoji(req.Msg.ServerId), data)
		}
	}

	return connect.NewResponse(&v1.CreateEmojiResponse{
		Emoji: emojiToProto(created),
	}), nil
}

func (s *chatService) DeleteEmoji(ctx context.Context, req *connect.Request[v1.DeleteEmojiRequest]) (*connect.Response[v1.DeleteEmojiResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing user"))
	}
	if req.Msg.EmojiId == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("emoji_id is required"))
	}

	// Look up emoji for IDOR prevention.
	emoji, err := s.emojiStore.GetEmoji(ctx, req.Msg.EmojiId)
	if err != nil {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("emoji not found"))
	}

	if emoji.ServerID == "" {
		// Personal emoji: caller must be the owner.
		if emoji.UserID != userID {
			return nil, connect.NewError(connect.CodeNotFound, errors.New("emoji not found"))
		}
	} else {
		// Server emoji: require membership + ManageEmojis permission.
		if err := s.requireMembership(ctx, userID, emoji.ServerID); err != nil {
			return nil, err
		}
		perms, permErr := s.resolvePermissions(ctx, userID, emoji.ServerID, "")
		if permErr != nil {
			return nil, permErr
		}
		if !permissions.Has(perms, permissions.ManageEmojis) {
			return nil, connect.NewError(connect.CodePermissionDenied, errors.New("missing permission"))
		}
	}

	if err := s.emojiStore.DeleteEmoji(ctx, req.Msg.EmojiId); err != nil {
		slog.Error("deleting emoji", "err", err, "user", userID, "emoji", req.Msg.EmojiId)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	// Broadcast event for server emojis only.
	if emoji.ServerID != "" {
		event := &v1.Event{
			Id:        models.NewID(),
			Type:      v1.EventType_EVENT_TYPE_EMOJI_DELETE,
			Timestamp: timestamppb.New(time.Now()),
			Payload: &v1.Event_EmojiDelete{
				EmojiDelete: &v1.EmojiDeleteEvent{
					ServerId: emoji.ServerID,
					EmojiId:  req.Msg.EmojiId,
				},
			},
		}
		if data, err := proto.Marshal(event); err != nil {
			slog.Error("marshaling event", "err", err)
		} else {
			s.nc.Publish(subjects.ServerEmoji(emoji.ServerID), data)
		}
	}

	return connect.NewResponse(&v1.DeleteEmojiResponse{}), nil
}

func (s *chatService) UpdateEmoji(ctx context.Context, req *connect.Request[v1.UpdateEmojiRequest]) (*connect.Response[v1.UpdateEmojiResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing user"))
	}
	if req.Msg.EmojiId == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("emoji_id is required"))
	}

	// Validate name format if provided.
	if req.Msg.Name != nil && !emojiNameRe.MatchString(*req.Msg.Name) {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("name must be 2-32 lowercase alphanumeric or underscore characters"))
	}

	// Look up emoji for IDOR prevention.
	emoji, err := s.emojiStore.GetEmoji(ctx, req.Msg.EmojiId)
	if err != nil {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("emoji not found"))
	}

	if emoji.ServerID == "" {
		// Personal emoji: caller must be the owner.
		if emoji.UserID != userID {
			return nil, connect.NewError(connect.CodeNotFound, errors.New("emoji not found"))
		}
	} else {
		// Server emoji: require membership + ManageEmojis permission.
		if err := s.requireMembership(ctx, userID, emoji.ServerID); err != nil {
			return nil, err
		}
		perms, permErr := s.resolvePermissions(ctx, userID, emoji.ServerID, "")
		if permErr != nil {
			return nil, permErr
		}
		if !permissions.Has(perms, permissions.ManageEmojis) {
			return nil, connect.NewError(connect.CodePermissionDenied, errors.New("missing permission"))
		}
	}

	updated, err := s.emojiStore.UpdateEmoji(ctx, req.Msg.EmojiId, req.Msg.Name)
	if err != nil {
		if strings.Contains(err.Error(), "duplicate key") || strings.Contains(err.Error(), "unique constraint") {
			return nil, connect.NewError(connect.CodeAlreadyExists, errors.New("an emoji with this name already exists"))
		}
		slog.Error("updating emoji", "err", err, "user", userID, "emoji", req.Msg.EmojiId)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	// Broadcast event for server emojis only.
	if emoji.ServerID != "" {
		event := &v1.Event{
			Id:        models.NewID(),
			Type:      v1.EventType_EVENT_TYPE_EMOJI_UPDATE,
			Timestamp: timestamppb.New(time.Now()),
			Payload: &v1.Event_EmojiUpdate{
				EmojiUpdate: emojiToProto(updated),
			},
		}
		if data, err := proto.Marshal(event); err != nil {
			slog.Error("marshaling event", "err", err)
		} else {
			s.nc.Publish(subjects.ServerEmoji(emoji.ServerID), data)
		}
	}

	return connect.NewResponse(&v1.UpdateEmojiResponse{
		Emoji: emojiToProto(updated),
	}), nil
}

func (s *chatService) ListEmojis(ctx context.Context, req *connect.Request[v1.ListEmojisRequest]) (*connect.Response[v1.ListEmojisResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing user"))
	}
	if req.Msg.ServerId == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("server_id is required"))
	}

	if err := s.requireMembership(ctx, userID, req.Msg.ServerId); err != nil {
		return nil, err
	}

	emojis, err := s.emojiStore.ListEmojis(ctx, req.Msg.ServerId)
	if err != nil {
		slog.Error("listing emojis", "err", err, "server", req.Msg.ServerId)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	protoEmojis := make([]*v1.CustomEmoji, len(emojis))
	for i, e := range emojis {
		protoEmojis[i] = emojiToProto(e)
	}

	return connect.NewResponse(&v1.ListEmojisResponse{
		Emojis: protoEmojis,
	}), nil
}

func (s *chatService) ListUserEmojis(ctx context.Context, _ *connect.Request[v1.ListUserEmojisRequest]) (*connect.Response[v1.ListUserEmojisResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing user"))
	}

	emojis, err := s.emojiStore.ListEmojisByUser(ctx, userID)
	if err != nil {
		slog.Error("listing user emojis", "err", err, "user", userID)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	protoEmojis := make([]*v1.CustomEmoji, len(emojis))
	for i, e := range emojis {
		protoEmojis[i] = emojiToProto(e)
	}

	return connect.NewResponse(&v1.ListUserEmojisResponse{
		Emojis: protoEmojis,
	}), nil
}

// --- Proto conversion helper ---

func emojiToProto(e *models.Emoji) *v1.CustomEmoji {
	return &v1.CustomEmoji{
		Id:        e.ID,
		ServerId:  e.ServerID,
		Name:      e.Name,
		ImageUrl:  "/media/" + e.AttachmentID,
		Animated:  e.Animated,
		CreatorId: e.CreatorID,
		CreatedAt: timestamppb.New(e.CreatedAt),
		UserId:    e.UserID,
	}
}
