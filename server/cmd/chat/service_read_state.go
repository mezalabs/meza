package main

import (
	"context"
	"errors"
	"log/slog"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/meza-chat/meza/gen/meza/v1"
	"github.com/meza-chat/meza/internal/auth"
	"github.com/meza-chat/meza/internal/models"
	"github.com/meza-chat/meza/internal/subjects"
)

func (s *chatService) AckMessage(ctx context.Context, req *connect.Request[v1.AckMessageRequest]) (*connect.Response[v1.AckMessageResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing user"))
	}
	if req.Msg.ChannelId == "" || req.Msg.MessageId == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("channel_id and message_id are required"))
	}

	// Verify channel exists and user is a member.
	_, isMember, err := s.chatStore.GetChannelAndCheckMembership(ctx, req.Msg.ChannelId, userID)
	if err != nil {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("channel not found"))
	}
	if !isMember {
		return nil, connect.NewError(connect.CodePermissionDenied, errors.New("not a member of this server"))
	}

	// Upsert read state (only advances forward due to WHERE clause).
	if err := s.readStateStore.UpsertReadState(ctx, userID, req.Msg.ChannelId, req.Msg.MessageId); err != nil {
		slog.Error("upserting read state", "err", err, "user", userID, "channel", req.Msg.ChannelId)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	// Compute new unread count.
	unreadCount, err := s.messageStore.CountMessagesAfter(ctx, req.Msg.ChannelId, req.Msg.MessageId)
	if err != nil {
		slog.Error("counting unread messages", "err", err, "user", userID, "channel", req.Msg.ChannelId)
		// Non-fatal: return 0 count rather than failing the RPC.
		unreadCount = 0
	}

	readState := &v1.ReadState{
		ChannelId:         req.Msg.ChannelId,
		LastReadMessageId: req.Msg.MessageId,
		UnreadCount:       unreadCount,
	}

	// Publish read state update to the user's personal NATS subject
	// so all their connected devices get the update.
	event := &v1.Event{
		Id:        models.NewID(),
		Type:      v1.EventType_EVENT_TYPE_READ_STATE_UPDATE,
		Timestamp: timestamppb.Now(),
		Payload:   &v1.Event_ReadStateUpdate{ReadStateUpdate: readState},
	}
	eventData, err := proto.Marshal(event)
	if err != nil {
		slog.Error("marshaling read state event", "err", err)
	} else {
		s.nc.Publish(subjects.UserReadState(userID), eventData)
	}

	return connect.NewResponse(&v1.AckMessageResponse{ReadState: readState}), nil
}
