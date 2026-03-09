package main

import (
	"context"
	"errors"

	"connectrpc.com/connect"

	v1 "github.com/mezalabs/meza/gen/meza/v1"
	"github.com/mezalabs/meza/internal/auth"
)

func (s *chatService) GetMutualServers(ctx context.Context, req *connect.Request[v1.GetMutualServersRequest]) (*connect.Response[v1.GetMutualServersResponse], error) {
	callerID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("authentication required"))
	}

	if req.Msg.UserId == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("user_id is required"))
	}
	if req.Msg.UserId == callerID {
		return connect.NewResponse(&v1.GetMutualServersResponse{}), nil
	}

	blocked, err := s.blockStore.IsBlockedEither(ctx, callerID, req.Msg.UserId)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}
	if blocked {
		return connect.NewResponse(&v1.GetMutualServersResponse{}), nil
	}

	servers, err := s.chatStore.GetMutualServers(ctx, callerID, req.Msg.UserId)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	resp := &v1.GetMutualServersResponse{}
	for _, srv := range servers {
		resp.Servers = append(resp.Servers, serverToProto(srv))
	}
	return connect.NewResponse(resp), nil
}

func (s *chatService) GetMutualFriends(ctx context.Context, req *connect.Request[v1.GetMutualFriendsRequest]) (*connect.Response[v1.GetMutualFriendsResponse], error) {
	callerID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("authentication required"))
	}

	if req.Msg.UserId == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("user_id is required"))
	}
	if req.Msg.UserId == callerID {
		return connect.NewResponse(&v1.GetMutualFriendsResponse{}), nil
	}

	blocked, err := s.blockStore.IsBlockedEither(ctx, callerID, req.Msg.UserId)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}
	if blocked {
		return connect.NewResponse(&v1.GetMutualFriendsResponse{}), nil
	}

	users, err := s.friendStore.GetMutualFriends(ctx, callerID, req.Msg.UserId)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	resp := &v1.GetMutualFriendsResponse{}
	for _, u := range users {
		pu := userToProto(u)
		// Strip private fields — callers only need identity info for mutual friends.
		pu.DmPrivacy = ""
		resp.Users = append(resp.Users, pu)
	}
	return connect.NewResponse(resp), nil
}
