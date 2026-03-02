package main

import (
	"context"
	"errors"
	"log/slog"

	"connectrpc.com/connect"

	v1 "github.com/meza-chat/meza/gen/meza/v1"
	"github.com/meza-chat/meza/internal/auth"
	"github.com/livekit/protocol/livekit"
)

func (s *voiceService) GetUserVoiceActivity(ctx context.Context, req *connect.Request[v1.GetUserVoiceActivityRequest]) (*connect.Response[v1.GetUserVoiceActivityResponse], error) {
	callerID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("authentication required"))
	}

	if req.Msg.UserId == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("user_id is required"))
	}

	// Looking at your own activity is allowed — same flow.
	targetUserID := req.Msg.UserId

	// Block check: don't reveal voice activity to/from blocked users.
	if callerID != targetUserID {
		blocked, err := s.blockStore.IsBlockedEither(ctx, callerID, targetUserID)
		if err != nil {
			slog.Error("check blocks for voice activity", "err", err, "caller", callerID, "target", targetUserID)
			return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
		}
		if blocked {
			return connect.NewResponse(&v1.GetUserVoiceActivityResponse{}), nil
		}
	}

	// Get servers where both the caller and target are members.
	mutualServers, err := s.chatStore.GetMutualServers(ctx, callerID, targetUserID)
	if err != nil {
		slog.Error("get mutual servers for voice activity", "err", err, "caller", callerID, "target", targetUserID)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	if len(mutualServers) == 0 {
		return connect.NewResponse(&v1.GetUserVoiceActivityResponse{}), nil
	}

	var activities []*v1.UserVoiceActivity

	// Cap at 10 mutual servers to bound the number of LiveKit RPCs.
	limit := len(mutualServers)
	if limit > 10 {
		limit = 10
	}

outer:
	for _, srv := range mutualServers[:limit] {
		// List channels for this server (passing callerID for potential permission filtering).
		channels, err := s.chatStore.ListChannels(ctx, srv.ID, callerID)
		if err != nil {
			slog.Error("list channels for voice activity", "err", err, "server", srv.ID)
			continue
		}

		for _, ch := range channels {
			if ch.Type != channelTypeVoice {
				continue
			}

			room := roomName(ch.ID)
			participant, err := s.lkClient.GetParticipant(ctx, &livekit.RoomParticipantIdentity{
				Room:     room,
				Identity: targetUserID,
			})
			if err != nil {
				// Not found means the user isn't in this room — skip.
				if isNotFound(err) {
					continue
				}
				slog.Error("get livekit participant", "err", err, "room", room, "user", targetUserID)
				continue
			}

			activities = append(activities, &v1.UserVoiceActivity{
				ChannelId:        ch.ID,
				ChannelName:      ch.Name,
				ServerId:         srv.ID,
				ServerName:       srv.Name,
				IsStreamingVideo: hasScreenShareTrack(participant),
			})
			// Users can only be in one voice channel — stop searching.
			break outer
		}
	}

	return connect.NewResponse(&v1.GetUserVoiceActivityResponse{
		Activities: activities,
	}), nil
}
