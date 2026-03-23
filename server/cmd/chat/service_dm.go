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
	"github.com/mezalabs/meza/internal/subjects"
)

var errUnableToMessage = connect.NewError(connect.CodePermissionDenied, errors.New("Unable to message this user"))

func (s *chatService) CreateOrGetDMChannel(ctx context.Context, req *connect.Request[v1.CreateOrGetDMChannelRequest]) (*connect.Response[v1.CreateOrGetDMChannelResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing user"))
	}
	recipientID := req.Msg.RecipientId
	if recipientID == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("recipient_id is required"))
	}
	if userID == recipientID {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("cannot DM yourself"))
	}

	// Per-user rate limit: 20 DM creations per 60 seconds.
	if err := s.checkRateLimit(ctx, "dm_rl", userID, 60, 20); err != nil {
		return nil, err
	}

	// Verify recipient exists.
	recipient, err := s.authStore.GetUserByID(ctx, recipientID)
	if err != nil {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("recipient not found"))
	}

	caller, err := s.authStore.GetUserByID(ctx, userID)
	if err != nil {
		slog.Error("getting caller user", "err", err, "user", userID)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	// Block check: either direction blocks the DM.
	blocked, err := s.blockStore.IsBlockedEither(ctx, userID, recipientID)
	if err != nil {
		slog.Error("checking block status", "err", err, "user", userID, "recipient", recipientID)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}
	if blocked {
		return nil, errUnableToMessage
	}

	// Check for existing DM channel.
	existing, err := s.chatStore.GetDMChannelByPairKey(ctx, userID, recipientID)
	if err != nil {
		slog.Error("checking existing DM channel", "err", err, "user", userID, "recipient", recipientID)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}
	if existing != nil {
		switch existing.DMStatus {
		case "declined":
			if existing.DMInitiatorID == userID {
				// Sender re-opens a declined channel: return silently, no status change.
				return s.buildDMResponse(existing, caller, recipient, false), nil
			}
			// Recipient wants to reach out after declining: flip to active.
			if err := s.chatStore.UpdateDMStatus(ctx, existing.ID, "active"); err != nil {
				slog.Error("reversing decline on DM", "err", err, "channel", existing.ID)
				return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
			}
			existing.DMStatus = "active"
			return s.buildDMResponse(existing, caller, recipient, false), nil
		default:
			// active or pending: return existing channel.
			return s.buildDMResponse(existing, caller, recipient, false), nil
		}
	}

	// No existing channel — check recipient's dm_privacy setting.
	dmStatus := "active"
	dmInitiatorID := ""

	// Check friendship once up front — used by friends, mutual_servers, and message_requests cases.
	areFriends, err := s.friendStore.AreFriends(ctx, userID, recipientID)
	if err != nil {
		slog.Error("checking friendship for DM privacy", "err", err, "user", userID, "recipient", recipientID)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	switch recipient.DMPrivacy {
	case "nobody":
		return nil, errUnableToMessage

	case "friends":
		if !areFriends {
			dmStatus = "pending"
			dmInitiatorID = userID
		}

	case "mutual_servers":
		if !areFriends {
			mutual, err := s.chatStore.ShareAnyServer(ctx, userID, recipientID)
			if err != nil {
				slog.Error("checking mutual servers", "err", err, "user", userID, "recipient", recipientID)
				return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
			}
			if !mutual {
				return nil, errUnableToMessage
			}
		}

	case "message_requests":
		if !areFriends {
			mutual, err := s.chatStore.ShareAnyServer(ctx, userID, recipientID)
			if err != nil {
				slog.Error("checking mutual servers", "err", err, "user", userID, "recipient", recipientID)
				return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
			}
			if !mutual {
				dmStatus = "pending"
				dmInitiatorID = userID
			}
		}

	case "anyone", "":
		// No gating.
	}

	ch, created, err := s.chatStore.CreateDMChannel(ctx, userID, recipientID, dmStatus, dmInitiatorID)
	if err != nil {
		slog.Error("creating DM channel", "err", err, "user", userID, "recipient", recipientID)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	if created {
		// Notify gateways for channel subscription refresh.
		s.nc.Publish(subjects.UserSubscription(userID), nil)
		s.nc.Publish(subjects.UserSubscription(recipientID), nil)

		// If pending, publish DM_REQUEST_RECEIVED event to recipient.
		if dmStatus == "pending" {
			s.publishDMRequestEvent(ch, caller, recipient)
		}
	}

	return s.buildDMResponse(ch, caller, recipient, created), nil
}

func (s *chatService) buildDMResponse(ch *models.Channel, caller, recipient *models.User, created bool) *connect.Response[v1.CreateOrGetDMChannelResponse] {
	participants := []*v1.User{
		userToProto(caller),
		userToProto(recipient),
	}
	return connect.NewResponse(&v1.CreateOrGetDMChannelResponse{
		DmChannel: &v1.DMChannel{
			Channel:      channelToProto(ch),
			Participants: participants,
		},
		Created: created,
	})
}

func (s *chatService) publishDMRequestEvent(ch *models.Channel, sender, recipient *models.User) {
	dmChannel := &v1.DMChannel{
		Channel: channelToProto(ch),
		Participants: []*v1.User{
			userToProto(sender),
			userToProto(recipient),
		},
	}
	event := &v1.Event{
		Id:        models.NewID(),
		Type:      v1.EventType_EVENT_TYPE_DM_REQUEST_RECEIVED,
		Timestamp: timestamppb.New(time.Now()),
		Payload: &v1.Event_DmRequestReceived{
			DmRequestReceived: dmChannel,
		},
	}
	eventData, err := proto.Marshal(event)
	if err != nil {
		slog.Error("marshaling dm request event", "err", err)
		return
	}
	if err := s.nc.Publish(subjects.UserSubscription(recipient.ID), eventData); err != nil {
		slog.Warn("nats publish failed", "subject", subjects.UserSubscription(recipient.ID), "err", err)
	}
}

// checkDMPrivacy verifies that the caller is allowed to message the target user
// based on the target's dm_privacy setting. Returns nil if allowed, or an error.
func (s *chatService) checkDMPrivacy(ctx context.Context, callerID string, target *models.User) error {
	switch target.DMPrivacy {
	case "nobody":
		return errUnableToMessage
	case "friends":
		areFriends, err := s.friendStore.AreFriends(ctx, callerID, target.ID)
		if err != nil {
			slog.Error("checking friendship for DM privacy", "err", err, "user", callerID, "target", target.ID)
			return connect.NewError(connect.CodeInternal, errors.New("internal error"))
		}
		if !areFriends {
			return errUnableToMessage
		}
	case "mutual_servers":
		areFriends, err := s.friendStore.AreFriends(ctx, callerID, target.ID)
		if err != nil {
			slog.Error("checking friendship for DM privacy", "err", err, "user", callerID, "target", target.ID)
			return connect.NewError(connect.CodeInternal, errors.New("internal error"))
		}
		if !areFriends {
			mutual, err := s.chatStore.ShareAnyServer(ctx, callerID, target.ID)
			if err != nil {
				slog.Error("checking mutual servers", "err", err, "user", callerID, "target", target.ID)
				return connect.NewError(connect.CodeInternal, errors.New("internal error"))
			}
			if !mutual {
				return errUnableToMessage
			}
		}
	case "anyone", "message_requests", "":
		// For group DMs, we allow creation (no pending state for groups).
	}
	return nil
}

func (s *chatService) CreateGroupDMChannel(ctx context.Context, req *connect.Request[v1.CreateGroupDMChannelRequest]) (*connect.Response[v1.CreateGroupDMChannelResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing user"))
	}

	// Per-user rate limit: 10 group DM creations per 60 seconds.
	if err := s.checkRateLimit(ctx, "gdm_rl", userID, 60, 10); err != nil {
		return nil, err
	}

	participantIDs := req.Msg.ParticipantIds
	if len(participantIDs) < 2 {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("at least 2 participants required"))
	}
	if len(participantIDs) > 9 {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("maximum 9 other participants"))
	}

	// Deduplicate and validate.
	seen := make(map[string]bool, len(participantIDs)+1)
	seen[userID] = true
	var validIDs []string
	for _, pid := range participantIDs {
		if pid == "" || pid == userID || seen[pid] {
			continue
		}
		seen[pid] = true
		validIDs = append(validIDs, pid)
	}
	if len(validIDs) < 2 {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("at least 2 distinct participants required"))
	}

	// Verify all participants exist, are not blocked, and allow DMs from caller.
	participants := make([]*models.User, 0, len(validIDs)+1)
	caller, err := s.authStore.GetUserByID(ctx, userID)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}
	participants = append(participants, caller)

	for _, pid := range validIDs {
		blocked, err := s.blockStore.IsBlockedEither(ctx, userID, pid)
		if err != nil {
			slog.Error("checking block status", "err", err, "user", userID, "participant", pid)
			return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
		}
		if blocked {
			return nil, connect.NewError(connect.CodePermissionDenied, errors.New("cannot add blocked user to group DM"))
		}
		u, err := s.authStore.GetUserByID(ctx, pid)
		if err != nil {
			return nil, connect.NewError(connect.CodeNotFound, errors.New("participant not found: "+pid))
		}
		if err := s.checkDMPrivacy(ctx, userID, u); err != nil {
			return nil, err
		}
		participants = append(participants, u)
	}

	// All participant IDs including the caller.
	allIDs := append([]string{userID}, validIDs...)
	name := ""
	if req.Msg.Name != nil {
		name = *req.Msg.Name
	}
	ch, err := s.chatStore.CreateGroupDMChannel(ctx, userID, name, allIDs)
	if err != nil {
		slog.Error("creating group DM channel", "err", err, "user", userID)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	// Notify all participants' gateways for subscription refresh.
	for _, pid := range allIDs {
		s.nc.Publish(subjects.UserSubscription(pid), nil)
	}

	protoParticipants := make([]*v1.User, len(participants))
	for i, u := range participants {
		protoParticipants[i] = userToProto(u)
	}

	return connect.NewResponse(&v1.CreateGroupDMChannelResponse{
		DmChannel: &v1.DMChannel{
			Channel:      channelToProto(ch),
			Participants: protoParticipants,
		},
		Created: true,
	}), nil
}

func (s *chatService) ListDMChannels(ctx context.Context, _ *connect.Request[v1.ListDMChannelsRequest]) (*connect.Response[v1.ListDMChannelsResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing user"))
	}

	channels, err := s.chatStore.ListDMChannelsWithParticipants(ctx, userID)
	if err != nil {
		slog.Error("listing DM channels", "err", err, "user", userID)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	dmChannels := make([]*v1.DMChannel, 0, len(channels))
	for _, dm := range channels {
		participants := make([]*v1.User, len(dm.Participants))
		for i, u := range dm.Participants {
			p := u // copy for pointer
			participants[i] = userToProto(&p)
		}
		dmChannels = append(dmChannels, &v1.DMChannel{
			Channel:      channelToProto(&dm.Channel),
			Participants: participants,
		})
	}

	return connect.NewResponse(&v1.ListDMChannelsResponse{
		DmChannels: dmChannels,
	}), nil
}

func userToProto(u *models.User) *v1.User {
	return &v1.User{
		Id:          u.ID,
		Username:    u.Username,
		DisplayName: u.DisplayName,
		AvatarUrl:   u.AvatarURL,
		EmojiScale:  u.EmojiScale,
		CreatedAt:   timestamppb.New(u.CreatedAt),
	}
}
