package main

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"time"

	"sync"

	"connectrpc.com/connect"
	v1 "github.com/mezalabs/meza/gen/meza/v1"
	"github.com/mezalabs/meza/internal/auth"
	"github.com/mezalabs/meza/internal/permissions"
	"github.com/mezalabs/meza/internal/store"
	lkauth "github.com/livekit/protocol/auth"
	"github.com/livekit/protocol/livekit"
	lksdk "github.com/livekit/server-sdk-go/v2"
	"golang.org/x/time/rate"
)

// channelTypeVoice is the integer value of CHANNEL_TYPE_VOICE from the proto enum.
const channelTypeVoice = 2

// livekitRoomClient defines the subset of LiveKit room operations used by the voice service.
// This interface enables mocking in tests.
type livekitRoomClient interface {
	CreateRoom(ctx context.Context, req *livekit.CreateRoomRequest) (*livekit.Room, error)
	ListParticipants(ctx context.Context, req *livekit.ListParticipantsRequest) (*livekit.ListParticipantsResponse, error)
	GetParticipant(ctx context.Context, req *livekit.RoomParticipantIdentity) (*livekit.ParticipantInfo, error)
	RemoveParticipant(ctx context.Context, req *livekit.RoomParticipantIdentity) (*livekit.RemoveParticipantResponse, error)
}

// Compile-time check that *lksdk.RoomServiceClient satisfies the interface.
var _ livekitRoomClient = (*lksdk.RoomServiceClient)(nil)

type voiceService struct {
	chatStore   store.ChatStorer
	roleStore   store.RoleStorer
	blockStore  store.BlockStorer
	lkClient    livekitRoomClient
	lkKey       string
	lkSecret    string
	lkHost      string
	lkPublicURL string // URL sent to clients (may differ from lkHost when tunneling)

	previewLimiters   map[string]*rate.Limiter
	previewLimitersMu sync.Mutex
}

// previewLimiter returns a per-user rate limiter for preview token requests.
// Allows 1 request per 3 seconds with a burst of 3.
func (s *voiceService) previewLimiter(userID string) *rate.Limiter {
	s.previewLimitersMu.Lock()
	defer s.previewLimitersMu.Unlock()
	if s.previewLimiters == nil {
		s.previewLimiters = make(map[string]*rate.Limiter)
	}
	lim, ok := s.previewLimiters[userID]
	if !ok {
		lim = rate.NewLimiter(rate.Every(3*time.Second), 3)
		s.previewLimiters[userID] = lim
	}
	return lim
}

func roomName(channelID string) string {
	return "meza-" + channelID
}

func (s *voiceService) JoinVoiceChannel(ctx context.Context, req *connect.Request[v1.JoinVoiceChannelRequest]) (*connect.Response[v1.JoinVoiceChannelResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing user"))
	}

	if req.Msg.ChannelId == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("channel_id is required"))
	}

	channel, isMember, err := s.chatStore.GetChannelAndCheckMembership(ctx, req.Msg.ChannelId, userID)
	if err != nil {
		if strings.Contains(err.Error(), "not found") {
			return nil, connect.NewError(connect.CodeNotFound, errors.New("channel not found"))
		}
		slog.Error("get channel", "err", err, "channel", req.Msg.ChannelId)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}
	if !isMember {
		return nil, connect.NewError(connect.CodePermissionDenied, errors.New("not a member of this server"))
	}

	if channel.Type != channelTypeVoice {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("channel is not a voice channel"))
	}

	// Resolve screen share permission from roles.
	canScreenShare := false
	srv, err := s.chatStore.GetServer(ctx, channel.ServerID)
	if err != nil {
		slog.Error("get server", "err", err, "server", channel.ServerID)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}
	if srv.OwnerID == userID {
		canScreenShare = true // Server owner has all permissions.
	} else {
		// Fetch the @everyone role (id = serverID) for its implicit permissions.
		everyoneRole, evErr := s.roleStore.GetRole(ctx, channel.ServerID)
		if evErr != nil {
			slog.Error("get everyone role", "err", evErr, "server", channel.ServerID)
			return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
		}
		combined := everyoneRole.Permissions

		roles, rolesErr := s.roleStore.GetMemberRoles(ctx, userID, channel.ServerID)
		if rolesErr != nil {
			slog.Error("get member roles", "err", rolesErr, "user", userID, "server", channel.ServerID)
			return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
		}
		for _, r := range roles {
			combined |= r.Permissions
		}
		canScreenShare = permissions.Has(combined, permissions.StreamVideo)
	}

	name := roomName(req.Msg.ChannelId)

	// Create the LiveKit room (idempotent — ignore "already exists" errors).
	_, err = s.lkClient.CreateRoom(ctx, &livekit.CreateRoomRequest{
		Name:            name,
		EmptyTimeout:    300,
		MaxParticipants: 50,
	})
	if err != nil && !isAlreadyExists(err) {
		slog.Error("create livekit room", "err", err, "room", name)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	// Generate a LiveKit access token.
	token, err := s.newLiveKitToken(userID, name, canScreenShare)
	if err != nil {
		slog.Error("generate livekit token", "err", err, "user", userID, "room", name)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	return connect.NewResponse(&v1.JoinVoiceChannelResponse{
		LivekitUrl:     s.lkPublicURL,
		LivekitToken:   token,
		RoomName:       name,
		CanScreenShare: canScreenShare,
	}), nil
}

func (s *voiceService) LeaveVoiceChannel(ctx context.Context, req *connect.Request[v1.LeaveVoiceChannelRequest]) (*connect.Response[v1.LeaveVoiceChannelResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing user"))
	}

	if req.Msg.ChannelId == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("channel_id is required"))
	}

	_, isMember, err := s.chatStore.GetChannelAndCheckMembership(ctx, req.Msg.ChannelId, userID)
	if err != nil {
		if strings.Contains(err.Error(), "not found") {
			return nil, connect.NewError(connect.CodeNotFound, errors.New("channel not found"))
		}
		slog.Error("get channel", "err", err, "channel", req.Msg.ChannelId)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}
	if !isMember {
		return nil, connect.NewError(connect.CodePermissionDenied, errors.New("not a member of this server"))
	}

	name := roomName(req.Msg.ChannelId)

	// Remove the participant from the LiveKit room. Swallow "not found" errors
	// (the user may already have left).
	_, err = s.lkClient.RemoveParticipant(ctx, &livekit.RoomParticipantIdentity{
		Room:     name,
		Identity: userID,
	})
	if err != nil && !isNotFound(err) {
		slog.Error("remove livekit participant", "err", err, "user", userID, "room", name)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	return connect.NewResponse(&v1.LeaveVoiceChannelResponse{}), nil
}

func (s *voiceService) GetVoiceChannelState(ctx context.Context, req *connect.Request[v1.GetVoiceChannelStateRequest]) (*connect.Response[v1.GetVoiceChannelStateResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing user"))
	}

	if req.Msg.ChannelId == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("channel_id is required"))
	}

	_, isMember, err := s.chatStore.GetChannelAndCheckMembership(ctx, req.Msg.ChannelId, userID)
	if err != nil {
		if strings.Contains(err.Error(), "not found") {
			return nil, connect.NewError(connect.CodeNotFound, errors.New("channel not found"))
		}
		slog.Error("get channel", "err", err, "channel", req.Msg.ChannelId)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}
	if !isMember {
		return nil, connect.NewError(connect.CodePermissionDenied, errors.New("not a member of this server"))
	}

	name := roomName(req.Msg.ChannelId)

	// List participants in the LiveKit room. Swallow "room not found" errors
	// and return an empty list instead.
	resp, err := s.lkClient.ListParticipants(ctx, &livekit.ListParticipantsRequest{
		Room: name,
	})
	if err != nil {
		if isNotFound(err) {
			return connect.NewResponse(&v1.GetVoiceChannelStateResponse{}), nil
		}
		slog.Error("list livekit participants", "err", err, "room", name)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	participants := make([]*v1.VoiceParticipant, 0, len(resp.Participants))
	for _, p := range resp.Participants {
		// Skip hidden participants (e.g. stream preview connections).
		if p.GetPermission().GetHidden() {
			continue
		}
		participants = append(participants, &v1.VoiceParticipant{
			UserId:           p.Identity,
			IsMuted:          isParticipantMuted(p),
			IsStreamingVideo: hasScreenShareTrack(p),
		})
	}

	return connect.NewResponse(&v1.GetVoiceChannelStateResponse{
		Participants: participants,
	}), nil
}

func (s *voiceService) GetStreamPreviewToken(ctx context.Context, req *connect.Request[v1.GetStreamPreviewTokenRequest]) (*connect.Response[v1.GetStreamPreviewTokenResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing user"))
	}

	if req.Msg.ChannelId == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("channel_id is required"))
	}

	if !s.previewLimiter(userID).Allow() {
		return nil, connect.NewError(connect.CodeResourceExhausted, errors.New("too many preview requests"))
	}

	channel, isMember, err := s.chatStore.GetChannelAndCheckMembership(ctx, req.Msg.ChannelId, userID)
	if err != nil {
		if strings.Contains(err.Error(), "not found") {
			return nil, connect.NewError(connect.CodeNotFound, errors.New("channel not found"))
		}
		slog.Error("get channel", "err", err, "channel", req.Msg.ChannelId)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}
	if !isMember {
		return nil, connect.NewError(connect.CodePermissionDenied, errors.New("not a member of this server"))
	}

	if channel.Type != channelTypeVoice {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("channel is not a voice channel"))
	}

	name := roomName(req.Msg.ChannelId)

	// Only issue preview tokens when a screen share is actually active.
	// This limits the window for potential audio eavesdropping via modified clients.
	resp, err := s.lkClient.ListParticipants(ctx, &livekit.ListParticipantsRequest{
		Room: name,
	})
	if err != nil {
		if isNotFound(err) {
			return nil, connect.NewError(connect.CodeFailedPrecondition, errors.New("no active voice session"))
		}
		slog.Error("list participants for preview", "err", err, "room", name)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}
	hasStream := false
	for _, p := range resp.Participants {
		if hasScreenShareTrack(p) {
			hasStream = true
			break
		}
	}
	if !hasStream {
		return nil, connect.NewError(connect.CodeFailedPrecondition, errors.New("no active screen share"))
	}

	token, err := s.newPreviewToken(userID, name)
	if err != nil {
		slog.Error("generate preview token", "err", err, "user", userID, "room", name)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	return connect.NewResponse(&v1.GetStreamPreviewTokenResponse{
		LivekitUrl:   s.lkPublicURL,
		LivekitToken: token,
		RoomName:     name,
	}), nil
}

// newPreviewToken generates a hidden, subscribe-only LiveKit JWT for stream preview.
// The token cannot publish any tracks and expires in 60 seconds.
func (s *voiceService) newPreviewToken(userID, room string) (string, error) {
	canPublish := false
	at := lkauth.NewAccessToken(s.lkKey, s.lkSecret)
	at.SetVideoGrant(&lkauth.VideoGrant{
		RoomJoin:   true,
		Room:       room,
		Hidden:     true,
		CanPublish: &canPublish,
	}).
		SetIdentity("preview:" + userID).
		SetValidFor(60 * time.Second)

	return at.ToJWT()
}

// newLiveKitToken generates a signed LiveKit JWT for the given user and room.
// Every token grants microphone and unknown (soundboard) publish sources.
// When canScreenShare is true, the token also grants screen_share and screen_share_audio.
func (s *voiceService) newLiveKitToken(userID, room string, canScreenShare bool) (string, error) {
	sources := []string{"microphone", "unknown"}
	if canScreenShare {
		sources = append(sources, "screen_share", "screen_share_audio")
	}

	at := lkauth.NewAccessToken(s.lkKey, s.lkSecret)
	at.SetVideoGrant(&lkauth.VideoGrant{
		RoomJoin:          true,
		Room:              room,
		CanPublishSources: sources,
	}).
		SetIdentity(userID).
		SetValidFor(2 * time.Hour)

	return at.ToJWT()
}

// isParticipantMuted returns true if all of the participant's audio tracks are muted,
// or if the participant has no audio tracks at all.
func isParticipantMuted(p *livekit.ParticipantInfo) bool {
	for _, t := range p.Tracks {
		if t.Source == livekit.TrackSource_MICROPHONE {
			if !t.Muted {
				return false
			}
		}
	}
	return true
}

// hasScreenShareTrack returns true if the participant has an active screen share track.
func hasScreenShareTrack(p *livekit.ParticipantInfo) bool {
	for _, t := range p.Tracks {
		if t.Source == livekit.TrackSource_SCREEN_SHARE {
			return true
		}
	}
	return false
}

// isAlreadyExists checks whether the error indicates the resource already exists.
func isAlreadyExists(err error) bool {
	if err == nil {
		return false
	}
	msg := err.Error()
	return strings.Contains(msg, "already exists") || strings.Contains(msg, "AlreadyExists")
}

// isNotFound checks whether the error indicates the resource was not found.
func isNotFound(err error) bool {
	if err == nil {
		return false
	}
	msg := err.Error()
	return strings.Contains(msg, "not found") || strings.Contains(msg, "NotFound") || strings.Contains(msg, "not_found")
}

// Ensure voiceService implements the generated handler interface.
var _ = (interface {
	JoinVoiceChannel(context.Context, *connect.Request[v1.JoinVoiceChannelRequest]) (*connect.Response[v1.JoinVoiceChannelResponse], error)
	LeaveVoiceChannel(context.Context, *connect.Request[v1.LeaveVoiceChannelRequest]) (*connect.Response[v1.LeaveVoiceChannelResponse], error)
	GetVoiceChannelState(context.Context, *connect.Request[v1.GetVoiceChannelStateRequest]) (*connect.Response[v1.GetVoiceChannelStateResponse], error)
	GetUserVoiceActivity(context.Context, *connect.Request[v1.GetUserVoiceActivityRequest]) (*connect.Response[v1.GetUserVoiceActivityResponse], error)
})((*voiceService)(nil))
