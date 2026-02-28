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
	"github.com/meza-chat/meza/internal/subjects"
)

func (s *chatService) AcceptMessageRequest(ctx context.Context, req *connect.Request[v1.AcceptMessageRequestReq]) (*connect.Response[v1.AcceptMessageRequestRes], error) {
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
	if !isMember || !s.isDMChannel(ch) {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("channel not found"))
	}
	if ch.DMStatus != "pending" {
		return nil, connect.NewError(connect.CodeFailedPrecondition, errors.New("channel is not a pending request"))
	}
	// Only the recipient (not the initiator) can accept.
	if ch.DMInitiatorID == userID {
		return nil, connect.NewError(connect.CodePermissionDenied, errors.New("only the recipient can accept a message request"))
	}

	if err := s.chatStore.UpdateDMStatus(ctx, ch.ID, "active"); err != nil {
		slog.Error("accepting message request", "err", err, "channel", ch.ID)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}
	ch.DMStatus = "active"

	// Fetch the two participants for the response.
	var participants []*v1.User
	otherID, err := s.chatStore.GetDMOtherParticipantID(ctx, ch.ID, userID)
	if err != nil {
		slog.Error("getting other participant after accept", "err", err)
	} else {
		if caller, err := s.authStore.GetUserByID(ctx, userID); err == nil {
			participants = append(participants, userToProto(caller))
		}
		if other, err := s.authStore.GetUserByID(ctx, otherID); err == nil {
			participants = append(participants, userToProto(other))
		}
	}

	dmChannel := &v1.DMChannel{
		Channel:      channelToProto(ch),
		Participants: participants,
	}

	// Publish accepted event to both users.
	event := &v1.Event{
		Id:        models.NewID(),
		Type:      v1.EventType_EVENT_TYPE_DM_REQUEST_ACCEPTED,
		Timestamp: timestamppb.New(time.Now()),
		Payload: &v1.Event_DmRequestAccepted{
			DmRequestAccepted: dmChannel,
		},
	}
	if eventData, err := proto.Marshal(event); err == nil {
		if err := s.nc.Publish(subjects.UserSubscription(ch.DMInitiatorID), eventData); err != nil {
			slog.Warn("nats publish failed", "subject", subjects.UserSubscription(ch.DMInitiatorID), "err", err)
		}
		if err := s.nc.Publish(subjects.UserSubscription(userID), eventData); err != nil {
			slog.Warn("nats publish failed", "subject", subjects.UserSubscription(userID), "err", err)
		}
	}

	return connect.NewResponse(&v1.AcceptMessageRequestRes{
		DmChannel: dmChannel,
	}), nil
}

func (s *chatService) DeclineMessageRequest(ctx context.Context, req *connect.Request[v1.DeclineMessageRequestReq]) (*connect.Response[v1.DeclineMessageRequestRes], error) {
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
	if !isMember || !s.isDMChannel(ch) {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("channel not found"))
	}
	if ch.DMStatus != "pending" {
		return nil, connect.NewError(connect.CodeFailedPrecondition, errors.New("channel is not a pending request"))
	}
	if ch.DMInitiatorID == userID {
		return nil, connect.NewError(connect.CodePermissionDenied, errors.New("only the recipient can decline a message request"))
	}

	if err := s.chatStore.UpdateDMStatus(ctx, ch.ID, "declined"); err != nil {
		slog.Error("declining message request", "err", err, "channel", ch.ID)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	// Publish declined event to recipient only (sender shouldn't know).
	event := &v1.Event{
		Id:        models.NewID(),
		Type:      v1.EventType_EVENT_TYPE_DM_REQUEST_DECLINED,
		Timestamp: timestamppb.New(time.Now()),
		Payload: &v1.Event_DmRequestDeclined{
			DmRequestDeclined: &v1.DMRequestDeclinedEvent{
				ChannelId: ch.ID,
			},
		},
	}
	if eventData, err := proto.Marshal(event); err == nil {
		if err := s.nc.Publish(subjects.UserSubscription(userID), eventData); err != nil {
			slog.Warn("nats publish failed", "subject", subjects.UserSubscription(userID), "err", err)
		}
	}

	return connect.NewResponse(&v1.DeclineMessageRequestRes{}), nil
}

func (s *chatService) ReverseDecline(ctx context.Context, req *connect.Request[v1.ReverseDeclineRequest]) (*connect.Response[v1.ReverseDeclineResponse], error) {
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
	if !isMember || !s.isDMChannel(ch) {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("channel not found"))
	}
	if ch.DMStatus != "declined" {
		return nil, connect.NewError(connect.CodeFailedPrecondition, errors.New("channel is not declined"))
	}
	// Only the recipient (not the initiator) can reverse a decline.
	if ch.DMInitiatorID == userID {
		return nil, connect.NewError(connect.CodePermissionDenied, errors.New("only the recipient can reverse a decline"))
	}

	if err := s.chatStore.UpdateDMStatus(ctx, ch.ID, "active"); err != nil {
		slog.Error("reversing decline", "err", err, "channel", ch.ID)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}
	ch.DMStatus = "active"

	dmChannel := &v1.DMChannel{
		Channel: channelToProto(ch),
	}

	// Publish accepted event to both users so the channel reappears.
	event := &v1.Event{
		Id:        models.NewID(),
		Type:      v1.EventType_EVENT_TYPE_DM_REQUEST_ACCEPTED,
		Timestamp: timestamppb.New(time.Now()),
		Payload: &v1.Event_DmRequestAccepted{
			DmRequestAccepted: dmChannel,
		},
	}
	if eventData, err := proto.Marshal(event); err == nil {
		if err := s.nc.Publish(subjects.UserSubscription(ch.DMInitiatorID), eventData); err != nil {
			slog.Warn("nats publish failed", "subject", subjects.UserSubscription(ch.DMInitiatorID), "err", err)
		}
		if err := s.nc.Publish(subjects.UserSubscription(userID), eventData); err != nil {
			slog.Warn("nats publish failed", "subject", subjects.UserSubscription(userID), "err", err)
		}
	}

	return connect.NewResponse(&v1.ReverseDeclineResponse{
		DmChannel: dmChannel,
	}), nil
}

func (s *chatService) ListMessageRequests(ctx context.Context, _ *connect.Request[v1.ListMessageRequestsRequest]) (*connect.Response[v1.ListMessageRequestsResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing user"))
	}

	channels, err := s.chatStore.ListPendingDMRequests(ctx, userID)
	if err != nil {
		slog.Error("listing message requests", "err", err, "user", userID)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	dmChannels := make([]*v1.DMChannel, 0, len(channels))
	for _, dm := range channels {
		participants := make([]*v1.User, len(dm.Participants))
		for i, u := range dm.Participants {
			p := u
			participants[i] = userToProto(&p)
		}
		dmChannels = append(dmChannels, &v1.DMChannel{
			Channel:      channelToProto(&dm.Channel),
			Participants: participants,
		})
	}

	return connect.NewResponse(&v1.ListMessageRequestsResponse{
		DmChannels: dmChannels,
	}), nil
}
