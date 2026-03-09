package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/mezalabs/meza/gen/meza/v1"
	"github.com/mezalabs/meza/internal/auth"
	"github.com/mezalabs/meza/internal/models"
	"github.com/mezalabs/meza/internal/subjects"
)

func (s *chatService) BlockUser(ctx context.Context, req *connect.Request[v1.BlockUserRequest]) (*connect.Response[v1.BlockUserResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing user"))
	}
	targetID := req.Msg.UserId
	if targetID == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("user_id is required"))
	}
	if userID == targetID {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("cannot block yourself"))
	}

	// Block the user and remove any friendship atomically in a single transaction.
	// This prevents inconsistent state where the block succeeds but friendship removal fails.
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		slog.Error("begin block tx", "err", err, "blocker", userID, "blocked", targetID)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}
	defer tx.Rollback(ctx)

	if err := s.blockStore.BlockUserTx(ctx, tx, userID, targetID); err != nil {
		slog.Error("blocking user", "err", err, "blocker", userID, "blocked", targetID)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	if err := s.friendStore.RemoveFriendshipsByUserTx(ctx, tx, userID, targetID); err != nil {
		slog.Error("removing friendship on block", "err", err, "blocker", userID, "blocked", targetID)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	if err := tx.Commit(ctx); err != nil {
		slog.Error("commit block tx", "err", err, "blocker", userID, "blocked", targetID)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("commit block: %w", err))
	}

	// Check if a DM channel exists between the two users.
	var dmChannelID string
	existing, err := s.chatStore.GetDMChannelByPairKey(ctx, userID, targetID)
	if err != nil {
		slog.Error("checking DM channel for block", "err", err)
	} else if existing != nil {
		dmChannelID = existing.ID
	}

	// Publish block event to the blocker so their client can update state.
	blockerEvent := &v1.Event{
		Id:        models.NewID(),
		Type:      v1.EventType_EVENT_TYPE_USER_BLOCKED,
		Timestamp: timestamppb.New(time.Now()),
		Payload: &v1.Event_UserBlocked{
			UserBlocked: &v1.UserBlockEvent{
				UserId:    targetID,
				ChannelId: dmChannelID,
			},
		},
	}
	if data, err := proto.Marshal(blockerEvent); err == nil {
		if err := s.nc.Publish(subjects.UserSubscription(userID), data); err != nil {
			slog.Warn("nats publish failed", "subject", subjects.UserSubscription(userID), "err", err)
		}
	}
	// Send a minimal event to the blocked user so their client hides the DM,
	// but omit the blocker's user ID to prevent block detection.
	if dmChannelID != "" {
		blockedEvent := &v1.Event{
			Id:        models.NewID(),
			Type:      v1.EventType_EVENT_TYPE_USER_BLOCKED,
			Timestamp: timestamppb.New(time.Now()),
			Payload: &v1.Event_UserBlocked{
				UserBlocked: &v1.UserBlockEvent{
					ChannelId: dmChannelID,
				},
			},
		}
		if data, err := proto.Marshal(blockedEvent); err == nil {
			if err := s.nc.Publish(subjects.UserSubscription(targetID), data); err != nil {
				slog.Warn("nats publish failed", "subject", subjects.UserSubscription(targetID), "err", err)
			}
		}
	}

	return connect.NewResponse(&v1.BlockUserResponse{}), nil
}

func (s *chatService) UnblockUser(ctx context.Context, req *connect.Request[v1.UnblockUserRequest]) (*connect.Response[v1.UnblockUserResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing user"))
	}
	targetID := req.Msg.UserId
	if targetID == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("user_id is required"))
	}

	if err := s.blockStore.UnblockUser(ctx, userID, targetID); err != nil {
		slog.Error("unblocking user", "err", err, "blocker", userID, "blocked", targetID)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	// Publish unblock event to the caller so their client can restore the DM.
	event := &v1.Event{
		Id:        models.NewID(),
		Type:      v1.EventType_EVENT_TYPE_USER_UNBLOCKED,
		Timestamp: timestamppb.New(time.Now()),
		Payload: &v1.Event_UserUnblocked{
			UserUnblocked: &v1.UserBlockEvent{
				UserId: targetID,
			},
		},
	}
	if eventData, err := proto.Marshal(event); err == nil {
		if err := s.nc.Publish(subjects.UserSubscription(userID), eventData); err != nil {
			slog.Warn("nats publish failed", "subject", subjects.UserSubscription(userID), "err", err)
		}
	}

	return connect.NewResponse(&v1.UnblockUserResponse{}), nil
}

func (s *chatService) ListBlocks(ctx context.Context, _ *connect.Request[v1.ListBlocksRequest]) (*connect.Response[v1.ListBlocksResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing user"))
	}

	users, err := s.blockStore.ListBlocksWithUsers(ctx, userID)
	if err != nil {
		slog.Error("listing blocks", "err", err, "user", userID)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	blockedUsers := make([]*v1.User, 0, len(users))
	for _, u := range users {
		blockedUsers = append(blockedUsers, userToProto(u))
	}

	return connect.NewResponse(&v1.ListBlocksResponse{
		BlockedUsers: blockedUsers,
	}), nil
}
