package main

import (
	"context"
	"errors"
	"log/slog"
	"sync"

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

	// Cap at 10 mutual servers to bound work.
	limit := len(mutualServers)
	if limit > 10 {
		limit = 10
	}

	// Phase 1: collect all voice channels across mutual servers (DB only, no LiveKit RPCs).
	type voiceChannel struct {
		channelID   string
		channelName string
		serverID    string
		serverName  string
	}
	var voiceChannels []voiceChannel

	for _, srv := range mutualServers[:limit] {
		channels, err := s.chatStore.ListChannels(ctx, srv.ID, callerID)
		if err != nil {
			slog.Error("list channels for voice activity", "err", err, "server", srv.ID)
			continue
		}
		for _, ch := range channels {
			if ch.Type == channelTypeVoice {
				voiceChannels = append(voiceChannels, voiceChannel{
					channelID: ch.ID, channelName: ch.Name,
					serverID: srv.ID, serverName: srv.Name,
				})
			}
		}
	}

	if len(voiceChannels) == 0 {
		return connect.NewResponse(&v1.GetUserVoiceActivityResponse{}), nil
	}

	// Phase 2: check LiveKit rooms in parallel (fan-out, first-hit-wins).
	// A user can only be in one voice channel, so we cancel remaining goroutines
	// as soon as the first match is found.
	type result struct {
		vc          voiceChannel
		participant *livekit.ParticipantInfo
	}
	resultCh := make(chan result, 1)
	searchCtx, cancel := context.WithCancel(ctx)
	defer cancel()

	var wg sync.WaitGroup
	for _, vc := range voiceChannels {
		wg.Add(1)
		go func(vc voiceChannel) {
			defer wg.Done()
			room := roomName(vc.channelID)
			participant, err := s.lkClient.GetParticipant(searchCtx, &livekit.RoomParticipantIdentity{
				Room:     room,
				Identity: targetUserID,
			})
			if err != nil {
				if !isNotFound(err) && searchCtx.Err() == nil {
					slog.Error("get livekit participant", "err", err, "room", room, "user", targetUserID)
				}
				return
			}
			// Non-blocking send — only the first match wins.
			select {
			case resultCh <- result{vc: vc, participant: participant}:
				cancel() // stop other goroutines
			default:
			}
		}(vc)
	}

	// Close channel once all goroutines finish.
	go func() { wg.Wait(); close(resultCh) }()

	var activities []*v1.UserVoiceActivity
	if r, ok := <-resultCh; ok {
		activities = append(activities, &v1.UserVoiceActivity{
			ChannelId:        r.vc.channelID,
			ChannelName:      r.vc.channelName,
			ServerId:         r.vc.serverID,
			ServerName:       r.vc.serverName,
			IsStreamingVideo: hasScreenShareTrack(r.participant),
		})
	}

	return connect.NewResponse(&v1.GetUserVoiceActivityResponse{
		Activities: activities,
	}), nil
}
