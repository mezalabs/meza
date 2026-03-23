package main

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/mezalabs/meza/gen/meza/v1"
	"github.com/mezalabs/meza/internal/auth"
	"github.com/mezalabs/meza/internal/models"
	"github.com/mezalabs/meza/internal/permissions"
	"github.com/mezalabs/meza/internal/subjects"
)

func channelGroupToProto(g *models.ChannelGroup) *v1.ChannelGroup {
	return &v1.ChannelGroup{
		Id:        g.ID,
		ServerId:  g.ServerID,
		Name:      g.Name,
		Position:  int32(g.Position),
		CreatedAt: timestamppb.New(g.CreatedAt),
	}
}

func (s *chatService) CreateChannelGroup(ctx context.Context, req *connect.Request[v1.CreateChannelGroupRequest]) (*connect.Response[v1.CreateChannelGroupResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing user"))
	}
	if req.Msg.ServerId == "" || req.Msg.Name == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("server_id and name are required"))
	}
	if len(req.Msg.Name) > 100 {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("name must be 100 characters or fewer"))
	}

	if err := s.requireMembership(ctx, userID, req.Msg.ServerId); err != nil {
		return nil, err
	}

	if _, _, _, err := s.requirePermission(ctx, userID, req.Msg.ServerId, permissions.ManageChannels); err != nil {
		return nil, err
	}

	group := &models.ChannelGroup{
		ID:        models.NewID(),
		ServerID:  req.Msg.ServerId,
		Name:      req.Msg.Name,
		CreatedAt: time.Now(),
	}

	created, err := s.channelGroupStore.CreateChannelGroup(ctx, group)
	if err != nil {
		slog.Error("creating channel group", "err", err, "user", userID, "server", req.Msg.ServerId)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	event := &v1.Event{
		Id:        models.NewID(),
		Type:      v1.EventType_EVENT_TYPE_CHANNEL_GROUP_CREATE,
		Timestamp: timestamppb.New(time.Now()),
		Payload: &v1.Event_ChannelGroupCreate{
			ChannelGroupCreate: channelGroupToProto(created),
		},
	}
	eventData, err := proto.Marshal(event)
	if err != nil {
		slog.Error("marshaling event", "err", err)
	} else {
		s.nc.Publish(subjects.ServerChannelGroup(req.Msg.ServerId), eventData)
	}

	return connect.NewResponse(&v1.CreateChannelGroupResponse{
		ChannelGroup: channelGroupToProto(created),
	}), nil
}

func (s *chatService) UpdateChannelGroup(ctx context.Context, req *connect.Request[v1.UpdateChannelGroupRequest]) (*connect.Response[v1.UpdateChannelGroupResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing user"))
	}
	if req.Msg.ChannelGroupId == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("channel_group_id is required"))
	}
	if req.Msg.Name != nil && len(*req.Msg.Name) > 100 {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("name must be 100 characters or fewer"))
	}

	group, err := s.channelGroupStore.GetChannelGroup(ctx, req.Msg.ChannelGroupId)
	if err != nil {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("channel group not found"))
	}

	if err := s.requireMembership(ctx, userID, group.ServerID); err != nil {
		return nil, err
	}

	if _, _, _, err := s.requirePermission(ctx, userID, group.ServerID, permissions.ManageChannels); err != nil {
		return nil, err
	}

	var name *string
	var position *int
	if req.Msg.Name != nil {
		name = req.Msg.Name
	}
	if req.Msg.Position != nil {
		p := int(*req.Msg.Position)
		position = &p
	}

	updated, err := s.channelGroupStore.UpdateChannelGroup(ctx, req.Msg.ChannelGroupId, name, position)
	if err != nil {
		slog.Error("updating channel group", "err", err, "user", userID, "group", req.Msg.ChannelGroupId)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	event := &v1.Event{
		Id:        models.NewID(),
		Type:      v1.EventType_EVENT_TYPE_CHANNEL_GROUP_UPDATE,
		Timestamp: timestamppb.New(time.Now()),
		Payload: &v1.Event_ChannelGroupUpdate{
			ChannelGroupUpdate: channelGroupToProto(updated),
		},
	}
	eventData, err := proto.Marshal(event)
	if err != nil {
		slog.Error("marshaling event", "err", err)
	} else {
		s.nc.Publish(subjects.ServerChannelGroup(group.ServerID), eventData)
	}

	return connect.NewResponse(&v1.UpdateChannelGroupResponse{
		ChannelGroup: channelGroupToProto(updated),
	}), nil
}

func (s *chatService) DeleteChannelGroup(ctx context.Context, req *connect.Request[v1.DeleteChannelGroupRequest]) (*connect.Response[v1.DeleteChannelGroupResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing user"))
	}
	if req.Msg.ChannelGroupId == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("channel_group_id is required"))
	}

	group, err := s.channelGroupStore.GetChannelGroup(ctx, req.Msg.ChannelGroupId)
	if err != nil {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("channel group not found"))
	}

	if err := s.requireMembership(ctx, userID, group.ServerID); err != nil {
		return nil, err
	}

	if _, _, _, err := s.requirePermission(ctx, userID, group.ServerID, permissions.ManageChannels); err != nil {
		return nil, err
	}
	// Snapshot materializes override rows — require ManageRoles too.
	if _, _, _, err := s.requirePermission(ctx, userID, group.ServerID, permissions.ManageRoles); err != nil {
		return nil, err
	}

	if err := s.chatStore.DeleteChannelGroupWithSnapshot(ctx, req.Msg.ChannelGroupId); err != nil {
		slog.Error("deleting channel group", "err", err, "user", userID, "group", req.Msg.ChannelGroupId)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	event := &v1.Event{
		Id:        models.NewID(),
		Type:      v1.EventType_EVENT_TYPE_CHANNEL_GROUP_DELETE,
		Timestamp: timestamppb.New(time.Now()),
		Payload: &v1.Event_ChannelGroupDelete{
			ChannelGroupDelete: &v1.ChannelGroupDeleteEvent{
				ServerId:       group.ServerID,
				ChannelGroupId: req.Msg.ChannelGroupId,
			},
		},
	}
	eventData, err := proto.Marshal(event)
	if err != nil {
		slog.Error("marshaling event", "err", err)
	} else {
		s.nc.Publish(subjects.ServerChannelGroup(group.ServerID), eventData)
	}

	// Snapshot materialized new override rows — invalidate permission cache and notify clients.
	s.permCache.InvalidateServer(ctx, group.ServerID)
	s.publishPermissionsUpdated(ctx, group.ServerID, "")

	return connect.NewResponse(&v1.DeleteChannelGroupResponse{}), nil
}

func (s *chatService) ListChannelGroups(ctx context.Context, req *connect.Request[v1.ListChannelGroupsRequest]) (*connect.Response[v1.ListChannelGroupsResponse], error) {
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

	groups, err := s.channelGroupStore.ListChannelGroups(ctx, req.Msg.ServerId)
	if err != nil {
		slog.Error("listing channel groups", "err", err, "server", req.Msg.ServerId)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	protoGroups := make([]*v1.ChannelGroup, len(groups))
	for i, g := range groups {
		protoGroups[i] = channelGroupToProto(g)
	}

	return connect.NewResponse(&v1.ListChannelGroupsResponse{
		ChannelGroups: protoGroups,
	}), nil
}
