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

	v1 "github.com/meza-chat/meza/gen/meza/v1"
	"github.com/meza-chat/meza/internal/auth"
	"github.com/meza-chat/meza/internal/models"
	"github.com/meza-chat/meza/internal/permissions"
	"github.com/meza-chat/meza/internal/store"
	"github.com/meza-chat/meza/internal/subjects"
)

func permissionOverrideToProto(o *models.PermissionOverride) *v1.PermissionOverride {
	targetID := o.ChannelGroupID
	if targetID == "" {
		targetID = o.ChannelID
	}
	return &v1.PermissionOverride{
		Id:       o.ID,
		TargetId: targetID,
		RoleId:   o.RoleID,
		UserId:   o.UserID,
		Allow:    o.Allow,
		Deny:     o.Deny,
	}
}

// resolveTargetServerID looks up the server that owns the given target (channel group or channel).
func (s *chatService) resolveTargetServerID(ctx context.Context, targetID string) (serverID string, isGroup bool, err error) {
	// Try channel group first.
	group, gErr := s.channelGroupStore.GetChannelGroup(ctx, targetID)
	if gErr == nil {
		return group.ServerID, true, nil
	}
	// Propagate real DB errors (not "not found").
	if !errors.Is(gErr, store.ErrNotFound) {
		return "", false, fmt.Errorf("lookup channel group %s: %w", targetID, gErr)
	}
	// Try channel.
	ch, cErr := s.chatStore.GetChannel(ctx, targetID)
	if cErr == nil {
		return ch.ServerID, false, nil
	}
	if !errors.Is(cErr, store.ErrNotFound) {
		return "", false, fmt.Errorf("lookup channel %s: %w", targetID, cErr)
	}
	return "", false, errors.New("target not found")
}

func (s *chatService) SetPermissionOverride(ctx context.Context, req *connect.Request[v1.SetPermissionOverrideRequest]) (*connect.Response[v1.SetPermissionOverrideResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing user"))
	}
	if req.Msg.TargetId == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("target_id is required"))
	}

	// Exactly one of role_id or user_id must be provided.
	isRoleOverride := req.Msg.RoleId != ""
	isUserOverride := req.Msg.UserId != ""
	if isRoleOverride == isUserOverride {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("exactly one of role_id or user_id is required"))
	}

	// Validate only channel-scoped bits are used.
	if !permissions.ValidateChannelScoped(req.Msg.Allow) {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("allow contains invalid permission bits"))
	}
	if !permissions.ValidateChannelScoped(req.Msg.Deny) {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("deny contains invalid permission bits"))
	}

	serverID, isGroup, err := s.resolveTargetServerID(ctx, req.Msg.TargetId)
	if err != nil {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("target not found"))
	}

	if !isGroup {
		isCompanion, compErr := s.chatStore.IsVoiceTextCompanion(ctx, req.Msg.TargetId)
		if compErr != nil {
			slog.Error("checking voice text companion for override", "err", compErr, "target", req.Msg.TargetId)
			return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
		}
		if isCompanion {
			return nil, connect.NewError(connect.CodeFailedPrecondition, errors.New("set overrides on the parent voice channel; they are mirrored automatically"))
		}
	}

	if err := s.requireMembership(ctx, userID, serverID); err != nil {
		return nil, err
	}

	callerPos, callerPerms, srv, permErr := s.requirePermission(ctx, userID, serverID, permissions.ManageRoles)
	if permErr != nil {
		return nil, permErr
	}

	override := &models.PermissionOverride{
		ID:    models.NewID(),
		Allow: req.Msg.Allow,
		Deny:  req.Msg.Deny,
	}
	if isGroup {
		override.ChannelGroupID = req.Msg.TargetId
	} else {
		override.ChannelID = req.Msg.TargetId
	}

	if isRoleOverride {
		// Hierarchy check: caller must outrank the target role.
		role, err := s.roleStore.GetRole(ctx, req.Msg.RoleId)
		if err != nil {
			return nil, connect.NewError(connect.CodeNotFound, errors.New("role not found"))
		}
		if role.ServerID != serverID {
			return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("role does not belong to this server"))
		}
		if callerPos <= role.Position {
			return nil, connect.NewError(connect.CodePermissionDenied, errors.New("cannot set overrides for a role at or above your position"))
		}
		override.RoleID = req.Msg.RoleId
	} else {
		// User override: verify target is a server member.
		if err := s.requireMembership(ctx, req.Msg.UserId, serverID); err != nil {
			return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("target user is not a member of this server"))
		}
		// Cannot target server owner (they already have all permissions).
		if req.Msg.UserId == srv.OwnerID {
			return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("cannot set overrides for the server owner"))
		}
		// Hierarchy check: caller's max role position must exceed target user's max role position.
		targetMember, err := s.chatStore.GetMember(ctx, req.Msg.UserId, serverID)
		if err != nil {
			return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
		}
		targetMaxPos := 0
		if len(targetMember.RoleIDs) > 0 {
			targetRoles, err := s.roleStore.GetRolesByIDs(ctx, targetMember.RoleIDs, serverID)
			if err != nil {
				return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
			}
			for _, r := range targetRoles {
				if r.Position > targetMaxPos {
					targetMaxPos = r.Position
				}
			}
		}
		if callerPos <= targetMaxPos && userID != srv.OwnerID {
			return nil, connect.NewError(connect.CodePermissionDenied, errors.New("cannot set overrides for a user at or above your role position"))
		}
		override.UserID = req.Msg.UserId
	}

	// Escalation check: cannot allow or deny permissions the caller does not have (owners exempt).
	if userID != srv.OwnerID {
		effectiveCallerPerms := callerPerms
		if permissions.Has(callerPerms, permissions.Administrator) {
			effectiveCallerPerms = permissions.AllPermissions
		}
		escalatedAllow := req.Msg.Allow & ^effectiveCallerPerms
		if escalatedAllow != 0 {
			return nil, connect.NewError(connect.CodePermissionDenied, errors.New("cannot allow permissions you do not have"))
		}
		escalatedDeny := req.Msg.Deny & ^effectiveCallerPerms
		if escalatedDeny != 0 {
			return nil, connect.NewError(connect.CodePermissionDenied, errors.New("cannot deny permissions you do not have"))
		}
	}

	created, err := s.permissionOverrideStore.SetOverride(ctx, override)
	if err != nil {
		slog.Error("setting permission override", "err", err, "user", userID, "target", req.Msg.TargetId)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	// Mirror override to companion text channel if target is a voice channel.
	if !isGroup && override.ChannelID != "" {
		targetCh, chErr := s.chatStore.GetChannel(ctx, override.ChannelID)
		if chErr == nil && targetCh.VoiceTextChannelID != "" {
			companionOverride := &models.PermissionOverride{
				ID:        models.NewID(),
				ChannelID: targetCh.VoiceTextChannelID,
				RoleID:    override.RoleID,
				UserID:    override.UserID,
				Allow:     override.Allow,
				Deny:      override.Deny,
			}
			if _, mirrorErr := s.permissionOverrideStore.SetOverride(ctx, companionOverride); mirrorErr != nil {
				slog.Error("mirroring override to companion channel", "err", mirrorErr, "companion", targetCh.VoiceTextChannelID)
			}
		}
	}

	// Invalidate permission cache for entire server (override change affects all members with this role).
	s.permCache.InvalidateServer(ctx, serverID)

	// Publish PERMISSION_OVERRIDE_UPDATE event.
	now := time.Now()
	overrideEvent := &v1.Event{
		Id:        models.NewID(),
		Type:      v1.EventType_EVENT_TYPE_PERMISSION_OVERRIDE_UPDATE,
		Timestamp: timestamppb.New(now),
		Payload: &v1.Event_PermissionOverrideUpdate{
			PermissionOverrideUpdate: &v1.PermissionOverrideUpdateEvent{
				Override: permissionOverrideToProto(created),
				ServerId: serverID,
			},
		},
	}
	if data, err := proto.Marshal(overrideEvent); err == nil {
		s.nc.Publish(subjects.ServerRole(serverID), data)
	}

	// Publish PERMISSIONS_UPDATED signal.
	s.publishPermissionsUpdated(ctx, serverID, req.Msg.TargetId)

	return connect.NewResponse(&v1.SetPermissionOverrideResponse{
		PermissionOverride: permissionOverrideToProto(created),
	}), nil
}

func (s *chatService) DeletePermissionOverride(ctx context.Context, req *connect.Request[v1.DeletePermissionOverrideRequest]) (*connect.Response[v1.DeletePermissionOverrideResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing user"))
	}
	if req.Msg.TargetId == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("target_id is required"))
	}

	// Exactly one of role_id or user_id must be provided.
	isRoleOverride := req.Msg.RoleId != ""
	isUserOverride := req.Msg.UserId != ""
	if isRoleOverride == isUserOverride {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("exactly one of role_id or user_id is required"))
	}

	serverID, isGroup, err := s.resolveTargetServerID(ctx, req.Msg.TargetId)
	if err != nil {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("target not found"))
	}

	if !isGroup {
		isCompanion, compErr := s.chatStore.IsVoiceTextCompanion(ctx, req.Msg.TargetId)
		if compErr != nil {
			slog.Error("checking voice text companion for override deletion", "err", compErr, "target", req.Msg.TargetId)
			return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
		}
		if isCompanion {
			return nil, connect.NewError(connect.CodeFailedPrecondition, errors.New("delete overrides on the parent voice channel; they are mirrored automatically"))
		}
	}

	if err := s.requireMembership(ctx, userID, serverID); err != nil {
		return nil, err
	}

	callerPos, _, srv, permErr := s.requirePermission(ctx, userID, serverID, permissions.ManageRoles)
	if permErr != nil {
		return nil, permErr
	}

	if isRoleOverride {
		// Hierarchy check: caller must outrank the target role.
		role, err := s.roleStore.GetRole(ctx, req.Msg.RoleId)
		if err != nil {
			return nil, connect.NewError(connect.CodeNotFound, errors.New("role not found"))
		}
		if role.ServerID != serverID {
			return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("role does not belong to this server"))
		}
		if callerPos <= role.Position {
			return nil, connect.NewError(connect.CodePermissionDenied, errors.New("cannot delete overrides for a role at or above your position"))
		}

		if err := s.permissionOverrideStore.DeleteOverride(ctx, req.Msg.TargetId, req.Msg.RoleId); err != nil {
			slog.Error("deleting permission override", "err", err, "user", userID, "target", req.Msg.TargetId)
			return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
		}
	} else {
		// User override: hierarchy check against target user's max role.
		if req.Msg.UserId == srv.OwnerID {
			return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("cannot delete overrides for the server owner"))
		}
		targetMember, err := s.chatStore.GetMember(ctx, req.Msg.UserId, serverID)
		if err != nil {
			// Member may have left — tolerate and allow deletion.
			if !errors.Is(err, store.ErrNotFound) {
				return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
			}
		} else {
			targetMaxPos := 0
			if len(targetMember.RoleIDs) > 0 {
				targetRoles, err := s.roleStore.GetRolesByIDs(ctx, targetMember.RoleIDs, serverID)
				if err != nil {
					return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
				}
				for _, r := range targetRoles {
					if r.Position > targetMaxPos {
						targetMaxPos = r.Position
					}
				}
			}
			if callerPos <= targetMaxPos && userID != srv.OwnerID {
				return nil, connect.NewError(connect.CodePermissionDenied, errors.New("cannot delete overrides for a user at or above your role position"))
			}
		}

		if err := s.permissionOverrideStore.DeleteOverrideByUser(ctx, req.Msg.TargetId, req.Msg.UserId); err != nil {
			slog.Error("deleting user permission override", "err", err, "user", userID, "target", req.Msg.TargetId)
			return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
		}
	}

	// Mirror override deletion to companion text channel if target is a voice channel.
	if !isGroup {
		targetCh, chErr := s.chatStore.GetChannel(ctx, req.Msg.TargetId)
		if chErr == nil && targetCh.VoiceTextChannelID != "" {
			if isRoleOverride {
				if err := s.permissionOverrideStore.DeleteOverride(ctx, targetCh.VoiceTextChannelID, req.Msg.RoleId); err != nil {
					slog.Error("mirroring override deletion to companion channel", "err", err, "companion", targetCh.VoiceTextChannelID)
				}
			} else {
				if err := s.permissionOverrideStore.DeleteOverrideByUser(ctx, targetCh.VoiceTextChannelID, req.Msg.UserId); err != nil {
					slog.Error("mirroring user override deletion to companion channel", "err", err, "companion", targetCh.VoiceTextChannelID)
				}
			}
		}
	}

	// Invalidate permission cache for entire server (override deletion affects all members with this role).
	s.permCache.InvalidateServer(ctx, serverID)

	// Publish PERMISSION_OVERRIDE_DELETE event.
	now := time.Now()
	deleteEvent := &v1.Event{
		Id:        models.NewID(),
		Type:      v1.EventType_EVENT_TYPE_PERMISSION_OVERRIDE_DELETE,
		Timestamp: timestamppb.New(now),
		Payload: &v1.Event_PermissionOverrideDelete{
			PermissionOverrideDelete: &v1.PermissionOverrideDeleteEvent{
				TargetId: req.Msg.TargetId,
				ServerId: serverID,
			},
		},
	}
	if data, err := proto.Marshal(deleteEvent); err == nil {
		s.nc.Publish(subjects.ServerRole(serverID), data)
	}

	// Publish PERMISSIONS_UPDATED signal.
	s.publishPermissionsUpdated(ctx, serverID, req.Msg.TargetId)

	return connect.NewResponse(&v1.DeletePermissionOverrideResponse{}), nil
}

func (s *chatService) ListPermissionOverrides(ctx context.Context, req *connect.Request[v1.ListPermissionOverridesRequest]) (*connect.Response[v1.ListPermissionOverridesResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing user"))
	}
	if req.Msg.TargetId == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("target_id is required"))
	}

	serverID, _, err := s.resolveTargetServerID(ctx, req.Msg.TargetId)
	if err != nil {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("target not found"))
	}

	if err := s.requireMembership(ctx, userID, serverID); err != nil {
		return nil, err
	}

	overrides, err := s.permissionOverrideStore.ListOverridesByTarget(ctx, req.Msg.TargetId)
	if err != nil {
		slog.Error("listing permission overrides", "err", err, "target", req.Msg.TargetId)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	protoOverrides := make([]*v1.PermissionOverride, len(overrides))
	for i, o := range overrides {
		protoOverrides[i] = permissionOverrideToProto(o)
	}

	return connect.NewResponse(&v1.ListPermissionOverridesResponse{
		PermissionOverrides: protoOverrides,
	}), nil
}
