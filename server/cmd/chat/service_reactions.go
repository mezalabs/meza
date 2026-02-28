package main

import (
	"context"
	"errors"
	"log/slog"
	"regexp"
	"time"
	"unicode/utf8"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/meza-chat/meza/gen/meza/v1"
	"github.com/meza-chat/meza/internal/auth"
	"github.com/meza-chat/meza/internal/models"
	"github.com/meza-chat/meza/internal/permissions"
	"github.com/meza-chat/meza/internal/subjects"
)

// maxUniqueEmojisPerMessage limits the number of distinct emoji reactions on a single message.
const maxUniqueEmojisPerMessage = 20

// customEmojiPattern matches custom emoji format: <:name:id> or <a:name:id>
// Name: 2-32 lowercase alphanumeric/underscores. ID: 1-26 alphanumeric (ULID length).
var customEmojiPattern = regexp.MustCompile(`^<a?:[a-z0-9_]{2,32}:[A-Za-z0-9]{1,26}>$`)

func validateEmoji(emoji string) error {
	if emoji == "" || len(emoji) > 100 {
		return errors.New("emoji must be 1-100 bytes")
	}
	// Custom emoji format.
	if len(emoji) > 1 && emoji[0] == '<' {
		if !customEmojiPattern.MatchString(emoji) {
			return errors.New("invalid custom emoji format")
		}
		return nil
	}
	// Native Unicode emoji: must be valid UTF-8 and reasonably short.
	if !utf8.ValidString(emoji) {
		return errors.New("invalid emoji encoding")
	}
	if utf8.RuneCountInString(emoji) > 32 {
		return errors.New("emoji too long")
	}
	return nil
}

func (s *chatService) AddReaction(ctx context.Context, req *connect.Request[v1.AddReactionRequest]) (*connect.Response[v1.AddReactionResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing user"))
	}
	if req.Msg.ChannelId == "" || req.Msg.MessageId == "" || req.Msg.Emoji == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("channel_id, message_id, and emoji are required"))
	}
	if err := validateEmoji(req.Msg.Emoji); err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, err)
	}

	// Verify channel exists and user is a member.
	ch, isMember, err := s.chatStore.GetChannelAndCheckMembership(ctx, req.Msg.ChannelId, userID)
	if err != nil {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("channel not found"))
	}
	if !isMember {
		return nil, connect.NewError(connect.CodePermissionDenied, errors.New("not a member of this server"))
	}
	if err := s.requireChannelAccess(ctx, ch, userID); err != nil {
		return nil, err
	}

	// Permission check (server channels only; DMs skip).
	if ch.ServerID != "" {
		perms, permErr := s.resolvePermissions(ctx, userID, ch.ServerID, ch.ID)
		if permErr != nil {
			return nil, permErr
		}
		if !permissions.Has(perms, permissions.AddReactions) {
			return nil, connect.NewError(connect.CodePermissionDenied, errors.New("missing AddReactions permission"))
		}
	}

	// Verify message exists and is not deleted.
	msg, err := s.messageStore.GetMessage(ctx, req.Msg.ChannelId, req.Msg.MessageId)
	if err != nil {
		slog.Error("getting message for reaction", "err", err, "user", userID, "channel", req.Msg.ChannelId)
		return nil, connect.NewError(connect.CodeNotFound, errors.New("message not found"))
	}
	if msg.Deleted {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("message not found"))
	}

	// Enforce per-message emoji limit.
	count, err := s.reactionStore.CountUniqueEmojis(ctx, req.Msg.ChannelId, req.Msg.MessageId)
	if err != nil {
		slog.Error("counting unique emojis", "err", err, "channel", req.Msg.ChannelId)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}
	if count >= maxUniqueEmojisPerMessage {
		return nil, connect.NewError(connect.CodeResourceExhausted, errors.New("reaction limit reached for this message"))
	}

	// Insert reaction (idempotent: ON CONFLICT DO NOTHING).
	if err := s.reactionStore.AddReaction(ctx, &models.Reaction{
		ChannelID: req.Msg.ChannelId,
		MessageID: req.Msg.MessageId,
		UserID:    userID,
		Emoji:     req.Msg.Emoji,
	}); err != nil {
		slog.Error("adding reaction", "err", err, "user", userID, "channel", req.Msg.ChannelId)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	// Broadcast REACTION_ADD event.
	now := time.Now()
	reaction := &v1.Reaction{
		ChannelId: req.Msg.ChannelId,
		MessageId: req.Msg.MessageId,
		UserId:    userID,
		Emoji:     req.Msg.Emoji,
		CreatedAt: timestamppb.New(now),
	}
	event := &v1.Event{
		Id:        models.NewID(),
		Type:      v1.EventType_EVENT_TYPE_REACTION_ADD,
		Timestamp: timestamppb.New(now),
		Payload:   &v1.Event_ReactionAdd{ReactionAdd: reaction},
	}
	eventData, err := proto.Marshal(event)
	if err != nil {
		slog.Error("marshaling event", "err", err)
	} else {
		s.nc.Publish(subjects.DeliverChannel(req.Msg.ChannelId), eventData)
	}

	return connect.NewResponse(&v1.AddReactionResponse{}), nil
}

func (s *chatService) RemoveReaction(ctx context.Context, req *connect.Request[v1.RemoveReactionRequest]) (*connect.Response[v1.RemoveReactionResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing user"))
	}
	if req.Msg.ChannelId == "" || req.Msg.MessageId == "" || req.Msg.Emoji == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("channel_id, message_id, and emoji are required"))
	}
	if err := validateEmoji(req.Msg.Emoji); err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, err)
	}

	// Verify channel exists and user is a member.
	ch, isMember, err := s.chatStore.GetChannelAndCheckMembership(ctx, req.Msg.ChannelId, userID)
	if err != nil {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("channel not found"))
	}
	if !isMember {
		return nil, connect.NewError(connect.CodePermissionDenied, errors.New("not a member of this server"))
	}
	if err := s.requireChannelAccess(ctx, ch, userID); err != nil {
		return nil, err
	}

	// Delete reaction.
	if err := s.reactionStore.RemoveReaction(ctx, req.Msg.ChannelId, req.Msg.MessageId, userID, req.Msg.Emoji); err != nil {
		slog.Error("removing reaction", "err", err, "user", userID, "channel", req.Msg.ChannelId)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	// Broadcast REACTION_REMOVE event.
	now := time.Now()
	reaction := &v1.Reaction{
		ChannelId: req.Msg.ChannelId,
		MessageId: req.Msg.MessageId,
		UserId:    userID,
		Emoji:     req.Msg.Emoji,
		CreatedAt: timestamppb.New(now),
	}
	event := &v1.Event{
		Id:        models.NewID(),
		Type:      v1.EventType_EVENT_TYPE_REACTION_REMOVE,
		Timestamp: timestamppb.New(now),
		Payload:   &v1.Event_ReactionRemove{ReactionRemove: reaction},
	}
	eventData, err := proto.Marshal(event)
	if err != nil {
		slog.Error("marshaling event", "err", err)
	} else {
		s.nc.Publish(subjects.DeliverChannel(req.Msg.ChannelId), eventData)
	}

	return connect.NewResponse(&v1.RemoveReactionResponse{}), nil
}

func (s *chatService) GetReactions(ctx context.Context, req *connect.Request[v1.GetReactionsRequest]) (*connect.Response[v1.GetReactionsResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing user"))
	}
	if req.Msg.ChannelId == "" || len(req.Msg.MessageIds) == 0 {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("channel_id and at least one message_id are required"))
	}
	if len(req.Msg.MessageIds) > 100 {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("too many message_ids (max 100)"))
	}

	ch, err := s.chatStore.GetChannel(ctx, req.Msg.ChannelId)
	if err != nil {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("channel not found"))
	}
	if err := s.requireMembership(ctx, userID, ch.ServerID); err != nil {
		return nil, err
	}
	if err := s.requireChannelAccess(ctx, ch, userID); err != nil {
		return nil, err
	}

	groups, err := s.reactionStore.GetReactionGroups(ctx, req.Msg.ChannelId, req.Msg.MessageIds, userID)
	if err != nil {
		slog.Error("getting reaction groups", "err", err, "user", userID, "channel", req.Msg.ChannelId)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	// Convert to proto response.
	protoReactions := make(map[string]*v1.ReactionGroupList, len(groups))
	for msgID, msgGroups := range groups {
		protoGroups := make([]*v1.ReactionGroup, len(msgGroups))
		for i, g := range msgGroups {
			protoGroups[i] = &v1.ReactionGroup{
				Emoji:   g.Emoji,
				Me:      g.Me,
				UserIds: g.UserIDs,
			}
		}
		protoReactions[msgID] = &v1.ReactionGroupList{Groups: protoGroups}
	}

	return connect.NewResponse(&v1.GetReactionsResponse{
		Reactions: protoReactions,
	}), nil
}
