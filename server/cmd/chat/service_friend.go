package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/mezalabs/meza/gen/meza/v1"
	"github.com/mezalabs/meza/internal/auth"
	"github.com/mezalabs/meza/internal/models"
	"github.com/mezalabs/meza/internal/subjects"
)

const (
	// friendRequestRateLimit is the maximum number of friend requests a user
	// can send per hour.
	friendRequestRateLimit = 10
	// friendRequestRateWindow is the sliding window for friend request rate limiting.
	friendRequestRateWindow = time.Hour
	// maxPendingOutgoingRequests is the maximum number of pending outgoing friend
	// requests a user can have at any given time.
	maxPendingOutgoingRequests = 100
)

func (s *chatService) SendFriendRequest(ctx context.Context, req *connect.Request[v1.SendFriendRequestRequest]) (*connect.Response[v1.SendFriendRequestResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing user"))
	}

	// Resolve target: either by user_id or by username (exactly one must be provided).
	targetID := req.Msg.UserId
	var targetUser *models.User

	if req.Msg.Username != nil && *req.Msg.Username != "" {
		if targetID != "" {
			return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("provide either user_id or username, not both"))
		}
		username := strings.ToLower(strings.TrimSpace(*req.Msg.Username))
		if username == "" {
			return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("username is required"))
		}
		u, _, err := s.authStore.GetUserByUsername(ctx, username)
		if err != nil {
			return nil, connect.NewError(connect.CodeNotFound, errors.New("user not found"))
		}
		targetUser = u
		targetID = u.ID
	} else if targetID == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("user_id or username is required"))
	}

	if userID == targetID {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("cannot send friend request to yourself"))
	}

	// Per-user rate limit: max 10 friend requests per hour via Redis counter.
	if s.rdb != nil {
		key := fmt.Sprintf("friend_request:%s", userID)
		count, err := s.rdb.Incr(ctx, key).Result()
		if err != nil {
			slog.Error("redis incr for friend request rate limit", "err", err, "user", userID)
			return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
		}
		// Set TTL on first increment so the window auto-expires.
		if count == 1 {
			s.rdb.Expire(ctx, key, friendRequestRateWindow)
		}
		if count > friendRequestRateLimit {
			return nil, connect.NewError(connect.CodeResourceExhausted, errors.New("too many friend requests, please try again later"))
		}
	}

	// Cap on pending outgoing requests: max 100 at any time.
	pendingCount, err := s.friendStore.CountPendingOutgoingRequests(ctx, userID)
	if err != nil {
		slog.Error("counting pending outgoing friend requests", "err", err, "user", userID)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}
	if pendingCount >= maxPendingOutgoingRequests {
		return nil, connect.NewError(connect.CodeResourceExhausted, errors.New("too many pending friend requests"))
	}

	// Block check: cannot friend someone who is blocked in either direction.
	// Returns CodeNotFound (same as non-existent user) to prevent enumeration.
	blocked, err := s.blockStore.IsBlockedEither(ctx, userID, targetID)
	if err != nil {
		slog.Error("checking block for friend request", "err", err, "user", userID, "target", targetID)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}
	if blocked {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("user not found"))
	}

	// Verify target user exists (skip if already fetched via username lookup).
	if targetUser == nil {
		targetUser, err = s.authStore.GetUserByID(ctx, targetID)
		if err != nil {
			return nil, connect.NewError(connect.CodeNotFound, errors.New("user not found"))
		}
	}

	// Friend request privacy check.
	if err := s.checkFriendRequestPrivacy(ctx, userID, targetUser); err != nil {
		return nil, err
	}

	autoAccepted, err := s.friendStore.SendFriendRequest(ctx, userID, targetID)
	if err != nil {
		slog.Error("sending friend request", "err", err, "requester", userID, "addressee", targetID)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	caller, err := s.authStore.GetUserByID(ctx, userID)
	if err != nil {
		slog.Error("getting caller for friend event", "err", err, "user", userID)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	if autoAccepted {
		// Mutual request: publish accepted events to both users.
		s.publishFriendEvent(v1.EventType_EVENT_TYPE_FRIEND_REQUEST_ACCEPTED, userID, targetUser)
		s.publishFriendEvent(v1.EventType_EVENT_TYPE_FRIEND_REQUEST_ACCEPTED, targetID, caller)
	} else {
		// Normal request: publish received event to addressee only.
		s.publishFriendEvent(v1.EventType_EVENT_TYPE_FRIEND_REQUEST_RECEIVED, targetID, caller)
	}

	return connect.NewResponse(&v1.SendFriendRequestResponse{
		AutoAccepted: autoAccepted,
	}), nil
}

// checkFriendRequestPrivacy verifies that the caller is allowed to send a
// friend request to the target user based on the target's
// friend_request_privacy setting.
func (s *chatService) checkFriendRequestPrivacy(ctx context.Context, callerID string, target *models.User) error {
	switch target.FriendRequestPrivacy {
	case "nobody":
		return connect.NewError(connect.CodeNotFound, errors.New("user not found"))
	case "server_co_members":
		areFriends, err := s.friendStore.AreFriends(ctx, callerID, target.ID)
		if err != nil {
			slog.Error("checking friendship for friend request privacy", "err", err)
			return connect.NewError(connect.CodeInternal, errors.New("internal error"))
		}
		if !areFriends {
			mutual, err := s.chatStore.ShareAnyServer(ctx, callerID, target.ID)
			if err != nil {
				slog.Error("checking mutual servers", "err", err)
				return connect.NewError(connect.CodeInternal, errors.New("internal error"))
			}
			if !mutual {
				return connect.NewError(connect.CodeNotFound, errors.New("user not found"))
			}
		}
	case "everyone", "":
		// allow
	}
	return nil
}

func (s *chatService) AcceptFriendRequest(ctx context.Context, req *connect.Request[v1.AcceptFriendRequestRequest]) (*connect.Response[v1.AcceptFriendRequestResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing user"))
	}
	requesterID := req.Msg.UserId
	if requesterID == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("user_id is required"))
	}

	if err := s.friendStore.AcceptFriendRequest(ctx, userID, requesterID); err != nil {
		slog.Error("accepting friend request", "err", err, "addressee", userID, "requester", requesterID)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	// Publish accepted event to requester (with acceptor's profile).
	caller, err := s.authStore.GetUserByID(ctx, userID)
	if err != nil {
		slog.Error("getting caller for friend accept event", "err", err, "user", userID)
	} else {
		s.publishFriendEvent(v1.EventType_EVENT_TYPE_FRIEND_REQUEST_ACCEPTED, requesterID, caller)
	}

	// Publish accepted event to acceptor so all their devices update.
	requesterUser, err := s.authStore.GetUserByID(ctx, requesterID)
	if err != nil {
		slog.Error("getting requester for friend accept event", "err", err, "user", requesterID)
	} else {
		s.publishFriendEvent(v1.EventType_EVENT_TYPE_FRIEND_REQUEST_ACCEPTED, userID, requesterUser)
	}

	// Auto-activate any pending DM between the two users.
	existing, err := s.chatStore.GetDMChannelByPairKey(ctx, userID, requesterID)
	if err == nil && existing != nil && existing.DMStatus == "pending" {
		if err := s.chatStore.UpdateDMStatus(ctx, existing.ID, "active"); err != nil {
			slog.Error("auto-activating DM on friend accept", "err", err, "channel", existing.ID)
		}
	}

	return connect.NewResponse(&v1.AcceptFriendRequestResponse{}), nil
}

func (s *chatService) DeclineFriendRequest(ctx context.Context, req *connect.Request[v1.DeclineFriendRequestRequest]) (*connect.Response[v1.DeclineFriendRequestResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing user"))
	}
	requesterID := req.Msg.UserId
	if requesterID == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("user_id is required"))
	}

	if err := s.friendStore.DeclineFriendRequest(ctx, userID, requesterID); err != nil {
		slog.Error("declining friend request", "err", err, "addressee", userID, "requester", requesterID)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	// Publish declined event to self only (for client state cleanup).
	requesterUser, err := s.authStore.GetUserByID(ctx, requesterID)
	if err != nil {
		slog.Error("getting requester for friend decline event", "err", err, "user", requesterID)
	} else {
		s.publishFriendEvent(v1.EventType_EVENT_TYPE_FRIEND_REQUEST_DECLINED, userID, requesterUser)
	}

	return connect.NewResponse(&v1.DeclineFriendRequestResponse{}), nil
}

func (s *chatService) CancelFriendRequest(ctx context.Context, req *connect.Request[v1.CancelFriendRequestRequest]) (*connect.Response[v1.CancelFriendRequestResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing user"))
	}
	addresseeID := req.Msg.UserId
	if addresseeID == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("user_id is required"))
	}

	if err := s.friendStore.CancelFriendRequest(ctx, userID, addresseeID); err != nil {
		slog.Error("cancelling friend request", "err", err, "requester", userID, "addressee", addresseeID)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	// Publish cancelled event to addressee so their incoming list updates.
	caller, err := s.authStore.GetUserByID(ctx, userID)
	if err != nil {
		slog.Error("getting caller for friend cancel event", "err", err, "user", userID)
	} else {
		s.publishFriendEvent(v1.EventType_EVENT_TYPE_FRIEND_REQUEST_CANCELLED, addresseeID, caller)
	}

	return connect.NewResponse(&v1.CancelFriendRequestResponse{}), nil
}

func (s *chatService) RemoveFriend(ctx context.Context, req *connect.Request[v1.RemoveFriendRequest]) (*connect.Response[v1.RemoveFriendResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing user"))
	}
	targetID := req.Msg.UserId
	if targetID == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("user_id is required"))
	}

	if err := s.friendStore.RemoveFriend(ctx, userID, targetID); err != nil {
		slog.Error("removing friend", "err", err, "user", userID, "target", targetID)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	// Publish removed event to the other user (silent store cleanup).
	caller, err := s.authStore.GetUserByID(ctx, userID)
	if err != nil {
		slog.Error("getting caller for friend remove event", "err", err, "user", userID)
	} else {
		s.publishFriendEvent(v1.EventType_EVENT_TYPE_FRIEND_REMOVED, targetID, caller)
	}

	return connect.NewResponse(&v1.RemoveFriendResponse{}), nil
}

func (s *chatService) ListFriends(ctx context.Context, _ *connect.Request[v1.ListFriendsRequest]) (*connect.Response[v1.ListFriendsResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing user"))
	}

	users, err := s.friendStore.ListFriendsWithUsers(ctx, userID)
	if err != nil {
		slog.Error("listing friends", "err", err, "user", userID)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	friends := make([]*v1.User, 0, len(users))
	for _, u := range users {
		friends = append(friends, userToProto(u))
	}

	return connect.NewResponse(&v1.ListFriendsResponse{
		Friends: friends,
	}), nil
}

func (s *chatService) ListFriendRequests(ctx context.Context, _ *connect.Request[v1.ListFriendRequestsRequest]) (*connect.Response[v1.ListFriendRequestsResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing user"))
	}

	incoming, err := s.friendStore.ListIncomingRequestsWithUsers(ctx, userID)
	if err != nil {
		slog.Error("listing incoming friend requests", "err", err, "user", userID)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	outgoing, err := s.friendStore.ListOutgoingRequestsWithUsers(ctx, userID)
	if err != nil {
		slog.Error("listing outgoing friend requests", "err", err, "user", userID)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	incomingProto := make([]*v1.FriendRequestEntry, 0, len(incoming))
	for _, r := range incoming {
		incomingProto = append(incomingProto, friendRequestToProto(r))
	}

	outgoingProto := make([]*v1.FriendRequestEntry, 0, len(outgoing))
	for _, r := range outgoing {
		outgoingProto = append(outgoingProto, friendRequestToProto(r))
	}

	return connect.NewResponse(&v1.ListFriendRequestsResponse{
		Incoming: incomingProto,
		Outgoing: outgoingProto,
	}), nil
}

func friendRequestToProto(r *models.FriendRequest) *v1.FriendRequestEntry {
	return &v1.FriendRequestEntry{
		User:      userToProto(r.User),
		Direction: r.Direction,
		CreatedAt: r.CreatedAt.Format(time.RFC3339),
	}
}

func (s *chatService) publishFriendEvent(eventType v1.EventType, targetUserID string, otherUser *models.User) {
	event := &v1.Event{
		Id:        models.NewID(),
		Type:      eventType,
		Timestamp: timestamppb.New(time.Now()),
	}

	friendEvent := &v1.FriendEvent{
		User: userToProto(otherUser),
	}

	switch eventType {
	case v1.EventType_EVENT_TYPE_FRIEND_REQUEST_RECEIVED:
		event.Payload = &v1.Event_FriendRequestReceived{FriendRequestReceived: friendEvent}
	case v1.EventType_EVENT_TYPE_FRIEND_REQUEST_ACCEPTED:
		event.Payload = &v1.Event_FriendRequestAccepted{FriendRequestAccepted: friendEvent}
	case v1.EventType_EVENT_TYPE_FRIEND_REQUEST_DECLINED:
		event.Payload = &v1.Event_FriendRequestDeclined{FriendRequestDeclined: friendEvent}
	case v1.EventType_EVENT_TYPE_FRIEND_REMOVED:
		event.Payload = &v1.Event_FriendRemoved{FriendRemoved: friendEvent}
	case v1.EventType_EVENT_TYPE_FRIEND_REQUEST_CANCELLED:
		event.Payload = &v1.Event_FriendRequestCancelled{FriendRequestCancelled: friendEvent}
	}

	data, err := proto.Marshal(event)
	if err != nil {
		slog.Error("marshaling friend event", "err", err, "type", eventType)
		return
	}
	if err := s.nc.Publish(subjects.UserSubscription(targetUserID), data); err != nil {
		slog.Warn("nats publish failed", "subject", subjects.UserSubscription(targetUserID), "err", err)
	}
}
