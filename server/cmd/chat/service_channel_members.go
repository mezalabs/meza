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
	"github.com/meza-chat/meza/internal/models"
	"github.com/meza-chat/meza/internal/permissions"
	"github.com/meza-chat/meza/internal/subjects"
)

func (s *chatService) AddChannelMember(ctx context.Context, req *connect.Request[v1.AddChannelMemberRequest]) (*connect.Response[v1.AddChannelMemberResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing user"))
	}
	if req.Msg.ChannelId == "" || req.Msg.UserId == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("channel_id and user_id are required"))
	}

	// Get the channel.
	ch, err := s.chatStore.GetChannel(ctx, req.Msg.ChannelId)
	if err != nil {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("channel not found"))
	}

	// Group DM path: only the creator (dm_initiator_id) can add members.
	if ch.Type == 4 {
		return s.addGroupDMMember(ctx, ch, userID, req.Msg.UserId)
	}

	if s.isDMChannel(ch) {
		return nil, connect.NewError(connect.CodeFailedPrecondition, errors.New("cannot modify DM channel members"))
	}

	// Require ManageChannels permission.
	_, _, _, permErr := s.requirePermission(ctx, userID, ch.ServerID, permissions.ManageChannels)
	if permErr != nil {
		return nil, permErr
	}

	// Verify target user is a server member.
	isMember, err := s.chatStore.IsMember(ctx, req.Msg.UserId, ch.ServerID)
	if err != nil {
		slog.Error("checking target membership", "err", err, "user", req.Msg.UserId, "server", ch.ServerID)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}
	if !isMember {
		return nil, connect.NewError(connect.CodeFailedPrecondition, errors.New("target user is not a server member"))
	}

	// Idempotent add (ON CONFLICT DO NOTHING).
	if err := s.chatStore.AddChannelMember(ctx, req.Msg.ChannelId, req.Msg.UserId); err != nil {
		slog.Error("adding channel member", "err", err, "channel", req.Msg.ChannelId, "user", req.Msg.UserId)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	// Publish channel member add event.
	s.publishChannelMemberEvent(ch, req.Msg.UserId, userID, v1.EventType_EVENT_TYPE_CHANNEL_MEMBER_ADD)

	return connect.NewResponse(&v1.AddChannelMemberResponse{}), nil
}

// addGroupDMMember handles adding a member to a group DM channel.
func (s *chatService) addGroupDMMember(ctx context.Context, ch *models.Channel, callerID, targetID string) (*connect.Response[v1.AddChannelMemberResponse], error) {
	// Only the creator can add members.
	if ch.DMInitiatorID != callerID {
		return nil, connect.NewError(connect.CodePermissionDenied, errors.New("only the group DM creator can add members"))
	}

	// Check participant cap (10 total).
	count, err := s.chatStore.CountChannelMembers(ctx, ch.ID)
	if err != nil {
		slog.Error("counting group DM members", "err", err, "channel", ch.ID)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}
	if count >= 10 {
		return nil, connect.NewError(connect.CodeFailedPrecondition, errors.New("group DM is full (maximum 10 participants)"))
	}

	// Block check.
	blocked, err := s.blockStore.IsBlockedEither(ctx, callerID, targetID)
	if err != nil {
		slog.Error("checking block status", "err", err, "user", callerID, "target", targetID)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}
	if blocked {
		return nil, connect.NewError(connect.CodePermissionDenied, errors.New("cannot add blocked user to group DM"))
	}

	// DM privacy check.
	target, err := s.authStore.GetUserByID(ctx, targetID)
	if err != nil {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("user not found"))
	}
	if err := s.checkDMPrivacy(ctx, callerID, target); err != nil {
		return nil, err
	}

	// Idempotent add.
	if err := s.chatStore.AddChannelMember(ctx, ch.ID, targetID); err != nil {
		slog.Error("adding group DM member", "err", err, "channel", ch.ID, "user", targetID)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	// Publish event and refresh subscriptions.
	s.publishChannelMemberEvent(ch, targetID, callerID, v1.EventType_EVENT_TYPE_CHANNEL_MEMBER_ADD)

	return connect.NewResponse(&v1.AddChannelMemberResponse{}), nil
}

func (s *chatService) RemoveChannelMember(ctx context.Context, req *connect.Request[v1.RemoveChannelMemberRequest]) (*connect.Response[v1.RemoveChannelMemberResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing user"))
	}
	if req.Msg.ChannelId == "" || req.Msg.UserId == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("channel_id and user_id are required"))
	}

	// Get the channel.
	ch, err := s.chatStore.GetChannel(ctx, req.Msg.ChannelId)
	if err != nil {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("channel not found"))
	}

	// Group DM path: creator can remove others, anyone can leave (self-remove).
	if ch.Type == 4 {
		return s.removeGroupDMMember(ctx, ch, userID, req.Msg.UserId)
	}

	if s.isDMChannel(ch) {
		return nil, connect.NewError(connect.CodeFailedPrecondition, errors.New("cannot modify DM channel members"))
	}

	// Allow self-removal. Otherwise require ManageChannels permission.
	if req.Msg.UserId != userID {
		_, _, _, permErr := s.requirePermission(ctx, userID, ch.ServerID, permissions.ManageChannels)
		if permErr != nil {
			return nil, permErr
		}
	} else {
		// Self-removal: just need to be a server member.
		if err := s.requireMembership(ctx, userID, ch.ServerID); err != nil {
			return nil, err
		}
	}

	// Idempotent remove.
	if err := s.chatStore.RemoveChannelMember(ctx, req.Msg.ChannelId, req.Msg.UserId); err != nil {
		slog.Error("removing channel member", "err", err, "channel", req.Msg.ChannelId, "user", req.Msg.UserId)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	// Publish event and refresh subscriptions.
	s.publishChannelMemberEvent(ch, req.Msg.UserId, userID, v1.EventType_EVENT_TYPE_CHANNEL_MEMBER_REMOVE)

	return connect.NewResponse(&v1.RemoveChannelMemberResponse{}), nil
}

// removeGroupDMMember handles removing a member from a group DM.
// The creator can remove others; any member can leave (self-remove).
// The creator cannot leave — they must transfer ownership first (deferred).
func (s *chatService) removeGroupDMMember(ctx context.Context, ch *models.Channel, callerID, targetID string) (*connect.Response[v1.RemoveChannelMemberResponse], error) {
	isSelfLeave := callerID == targetID

	if isSelfLeave {
		// Creator cannot leave without transferring ownership.
		if ch.DMInitiatorID == callerID {
			return nil, connect.NewError(connect.CodeFailedPrecondition, errors.New("group DM creator must transfer ownership before leaving"))
		}
	} else {
		// Only the creator can remove others.
		if ch.DMInitiatorID != callerID {
			return nil, connect.NewError(connect.CodePermissionDenied, errors.New("only the group DM creator can remove members"))
		}
	}

	// Idempotent remove.
	if err := s.chatStore.RemoveChannelMember(ctx, ch.ID, targetID); err != nil {
		slog.Error("removing group DM member", "err", err, "channel", ch.ID, "user", targetID)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	// Publish event and refresh subscriptions.
	s.publishChannelMemberEvent(ch, targetID, callerID, v1.EventType_EVENT_TYPE_CHANNEL_MEMBER_REMOVE)

	return connect.NewResponse(&v1.RemoveChannelMemberResponse{}), nil
}

// publishChannelMemberEvent publishes a channel member add/remove event
// and signals the gateway to refresh subscriptions for the affected user.
func (s *chatService) publishChannelMemberEvent(ch *models.Channel, targetID, actorID string, eventType v1.EventType) {
	now := time.Now()
	memberEvent := &v1.ChannelMemberEvent{
		ChannelId: ch.ID,
		UserId:    targetID,
		ServerId:  ch.ServerID,
		ActorId:   actorID,
	}

	var payload *v1.Event
	switch eventType {
	case v1.EventType_EVENT_TYPE_CHANNEL_MEMBER_ADD:
		payload = &v1.Event{
			Id:        models.NewID(),
			Type:      eventType,
			Timestamp: timestamppb.New(now),
			Payload:   &v1.Event_ChannelMemberAdd{ChannelMemberAdd: memberEvent},
		}
	case v1.EventType_EVENT_TYPE_CHANNEL_MEMBER_REMOVE:
		payload = &v1.Event{
			Id:        models.NewID(),
			Type:      eventType,
			Timestamp: timestamppb.New(now),
			Payload:   &v1.Event_ChannelMemberRemove{ChannelMemberRemove: memberEvent},
		}
	default:
		return
	}

	eventData, err := proto.Marshal(payload)
	if err != nil {
		slog.Error("marshaling event", "err", err)
		return
	}

	if s.isServerlessChannel(ch) {
		// DM/group DM: publish directly to the channel delivery subject.
		s.nc.Publish(subjects.DeliverChannel(ch.ID), eventData)
	} else {
		// Server channel: publish to the server channel subject with channel encoding.
		s.nc.Publish(subjects.ServerChannel(ch.ServerID), subjects.EncodeServerChannelEvent(eventData, ch.ID))
	}

	// Signal gateway to refresh channel subscriptions for the affected user.
	s.nc.Publish(subjects.UserSubscription(targetID), nil)
}

func (s *chatService) ListChannelMembers(ctx context.Context, req *connect.Request[v1.ListChannelMembersRequest]) (*connect.Response[v1.ListChannelMembersResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing user"))
	}
	if req.Msg.ChannelId == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("channel_id is required"))
	}

	ch, isMember, err := s.chatStore.GetChannelAndCheckMembership(ctx, req.Msg.ChannelId, userID)
	if err != nil {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("channel not found"))
	}
	if !isMember {
		return nil, connect.NewError(connect.CodePermissionDenied, errors.New("not a member"))
	}

	// Require channel access for server channels (private channel check).
	if err := s.requireChannelAccess(ctx, ch, userID); err != nil {
		return nil, err
	}

	members, err := s.chatStore.ListChannelMembers(ctx, req.Msg.ChannelId)
	if err != nil {
		slog.Error("listing channel members", "err", err, "channel", req.Msg.ChannelId)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	protoMembers := make([]*v1.Member, len(members))
	for i, m := range members {
		protoMembers[i] = memberToProto(m)
	}

	return connect.NewResponse(&v1.ListChannelMembersResponse{
		Members: protoMembers,
	}), nil
}
