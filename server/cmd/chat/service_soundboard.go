package main

import (
	"context"
	"errors"
	"log/slog"
	"regexp"
	"strings"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/meza-chat/meza/gen/meza/v1"
	"github.com/meza-chat/meza/internal/auth"
	"github.com/meza-chat/meza/internal/models"
	"github.com/meza-chat/meza/internal/permissions"
	"github.com/meza-chat/meza/internal/subjects"
)

const (
	maxPersonalSounds = 6
	maxServerSounds   = 12
)

var soundNameRe = regexp.MustCompile(`^[a-zA-Z0-9 _\-]{2,32}$`)

func (s *chatService) CreateSound(ctx context.Context, req *connect.Request[v1.CreateSoundRequest]) (*connect.Response[v1.CreateSoundResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing user"))
	}
	if req.Msg.Name == "" || req.Msg.AttachmentId == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("name and attachment_id are required"))
	}
	if !soundNameRe.MatchString(req.Msg.Name) {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("name must be 2-32 alphanumeric, space, underscore, or hyphen characters"))
	}

	isServerSound := req.Msg.ServerId != ""

	if isServerSound {
		if err := s.requireMembership(ctx, userID, req.Msg.ServerId); err != nil {
			return nil, err
		}
		perms, permErr := s.resolvePermissions(ctx, userID, req.Msg.ServerId, "")
		if permErr != nil {
			return nil, permErr
		}
		if !permissions.Has(perms, permissions.ManageSoundboard) {
			return nil, connect.NewError(connect.CodePermissionDenied, errors.New("missing permission"))
		}
	}

	sound := &models.SoundboardSound{
		ID:           models.NewID(),
		UserID:       userID,
		ServerID:     req.Msg.ServerId,
		Name:         req.Msg.Name,
		AttachmentID: req.Msg.AttachmentId,
		CreatedAt:    time.Now(),
	}

	created, err := s.soundboardStore.CreateSound(ctx, sound, maxPersonalSounds, maxServerSounds)
	if err != nil {
		if strings.Contains(err.Error(), "duplicate key") || strings.Contains(err.Error(), "unique constraint") {
			return nil, connect.NewError(connect.CodeAlreadyExists, errors.New("a sound with this name already exists"))
		}
		slog.Error("creating sound", "err", err, "user", userID)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}
	if created == nil {
		// Atomic insert returned no rows: either quota exceeded or attachment invalid.
		return nil, connect.NewError(connect.CodeResourceExhausted, errors.New("sound limit reached or attachment not valid"))
	}

	// Broadcast event for server sounds only.
	if isServerSound {
		event := &v1.Event{
			Id:        models.NewID(),
			Type:      v1.EventType_EVENT_TYPE_SOUND_CREATE,
			Timestamp: timestamppb.New(time.Now()),
			Payload:   &v1.Event_SoundCreate{SoundCreate: soundToProto(created)},
		}
		if data, err := proto.Marshal(event); err != nil {
			slog.Error("marshaling sound event", "err", err)
		} else {
			s.nc.Publish(subjects.ServerSoundboard(req.Msg.ServerId), data)
		}
	}

	return connect.NewResponse(&v1.CreateSoundResponse{
		Sound: soundToProto(created),
	}), nil
}

func (s *chatService) DeleteSound(ctx context.Context, req *connect.Request[v1.DeleteSoundRequest]) (*connect.Response[v1.DeleteSoundResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing user"))
	}
	if req.Msg.SoundId == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("sound_id is required"))
	}

	// Look up sound for IDOR prevention — derive server_id from DB record.
	sound, err := s.soundboardStore.GetSound(ctx, req.Msg.SoundId)
	if err != nil {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("sound not found"))
	}

	if sound.ServerID == "" {
		// Personal sound: caller must be the owner.
		if sound.UserID != userID {
			return nil, connect.NewError(connect.CodeNotFound, errors.New("sound not found"))
		}
	} else {
		// Server sound: require membership + ManageSoundboard permission.
		if err := s.requireMembership(ctx, userID, sound.ServerID); err != nil {
			return nil, err
		}
		perms, permErr := s.resolvePermissions(ctx, userID, sound.ServerID, "")
		if permErr != nil {
			return nil, permErr
		}
		if !permissions.Has(perms, permissions.ManageSoundboard) {
			return nil, connect.NewError(connect.CodePermissionDenied, errors.New("missing permission"))
		}
	}

	if err := s.soundboardStore.DeleteSound(ctx, req.Msg.SoundId); err != nil {
		slog.Error("deleting sound", "err", err, "user", userID, "sound", req.Msg.SoundId)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	// Broadcast event for server sounds only.
	if sound.ServerID != "" {
		event := &v1.Event{
			Id:        models.NewID(),
			Type:      v1.EventType_EVENT_TYPE_SOUND_DELETE,
			Timestamp: timestamppb.New(time.Now()),
			Payload: &v1.Event_SoundDelete{SoundDelete: &v1.SoundDeleteEvent{
				SoundId:  req.Msg.SoundId,
				ServerId: sound.ServerID,
			}},
		}
		if data, err := proto.Marshal(event); err != nil {
			slog.Error("marshaling sound event", "err", err)
		} else {
			s.nc.Publish(subjects.ServerSoundboard(sound.ServerID), data)
		}
	}

	return connect.NewResponse(&v1.DeleteSoundResponse{}), nil
}

func (s *chatService) UpdateSound(ctx context.Context, req *connect.Request[v1.UpdateSoundRequest]) (*connect.Response[v1.UpdateSoundResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing user"))
	}
	if req.Msg.SoundId == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("sound_id is required"))
	}
	if req.Msg.Name == nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("name is required"))
	}
	if !soundNameRe.MatchString(*req.Msg.Name) {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("name must be 2-32 alphanumeric, space, underscore, or hyphen characters"))
	}

	// Look up sound for IDOR prevention.
	sound, err := s.soundboardStore.GetSound(ctx, req.Msg.SoundId)
	if err != nil {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("sound not found"))
	}

	if sound.ServerID == "" {
		if sound.UserID != userID {
			return nil, connect.NewError(connect.CodeNotFound, errors.New("sound not found"))
		}
	} else {
		if err := s.requireMembership(ctx, userID, sound.ServerID); err != nil {
			return nil, err
		}
		perms, permErr := s.resolvePermissions(ctx, userID, sound.ServerID, "")
		if permErr != nil {
			return nil, permErr
		}
		if !permissions.Has(perms, permissions.ManageSoundboard) {
			return nil, connect.NewError(connect.CodePermissionDenied, errors.New("missing permission"))
		}
	}

	updated, err := s.soundboardStore.UpdateSound(ctx, req.Msg.SoundId, *req.Msg.Name)
	if err != nil {
		if strings.Contains(err.Error(), "duplicate key") || strings.Contains(err.Error(), "unique constraint") {
			return nil, connect.NewError(connect.CodeAlreadyExists, errors.New("a sound with this name already exists"))
		}
		slog.Error("updating sound", "err", err, "user", userID, "sound", req.Msg.SoundId)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	// Broadcast event for server sounds only.
	if sound.ServerID != "" {
		event := &v1.Event{
			Id:        models.NewID(),
			Type:      v1.EventType_EVENT_TYPE_SOUND_UPDATE,
			Timestamp: timestamppb.New(time.Now()),
			Payload:   &v1.Event_SoundUpdate{SoundUpdate: soundToProto(updated)},
		}
		if data, err := proto.Marshal(event); err != nil {
			slog.Error("marshaling sound event", "err", err)
		} else {
			s.nc.Publish(subjects.ServerSoundboard(sound.ServerID), data)
		}
	}

	return connect.NewResponse(&v1.UpdateSoundResponse{
		Sound: soundToProto(updated),
	}), nil
}

func (s *chatService) ListUserSounds(ctx context.Context, _ *connect.Request[v1.ListUserSoundsRequest]) (*connect.Response[v1.ListUserSoundsResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing user"))
	}

	sounds, err := s.soundboardStore.ListSoundsByUser(ctx, userID)
	if err != nil {
		slog.Error("listing user sounds", "err", err, "user", userID)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	protoSounds := make([]*v1.SoundboardSound, len(sounds))
	for i, snd := range sounds {
		protoSounds[i] = soundToProto(snd)
	}

	return connect.NewResponse(&v1.ListUserSoundsResponse{
		Sounds: protoSounds,
	}), nil
}

func (s *chatService) ListServerSounds(ctx context.Context, req *connect.Request[v1.ListServerSoundsRequest]) (*connect.Response[v1.ListServerSoundsResponse], error) {
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

	sounds, err := s.soundboardStore.ListSoundsByServer(ctx, req.Msg.ServerId)
	if err != nil {
		slog.Error("listing server sounds", "err", err, "server", req.Msg.ServerId)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	protoSounds := make([]*v1.SoundboardSound, len(sounds))
	for i, snd := range sounds {
		protoSounds[i] = soundToProto(snd)
	}

	return connect.NewResponse(&v1.ListServerSoundsResponse{
		Sounds: protoSounds,
	}), nil
}

// --- Helpers ---

func soundToProto(snd *models.SoundboardSound) *v1.SoundboardSound {
	return &v1.SoundboardSound{
		Id:        snd.ID,
		UserId:    snd.UserID,
		ServerId:  snd.ServerID,
		Name:      snd.Name,
		AudioUrl:  "/media/" + snd.AttachmentID,
		CreatedAt: timestamppb.New(snd.CreatedAt),
	}
}

