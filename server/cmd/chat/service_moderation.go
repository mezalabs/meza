package main

import (
	"context"
	"errors"
	"log/slog"
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

// --- Member moderation handlers ---

func (s *chatService) ListMembers(ctx context.Context, req *connect.Request[v1.ListMembersRequest]) (*connect.Response[v1.ListMembersResponse], error) {
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

	members, err := s.chatStore.ListMembers(ctx, req.Msg.ServerId, req.Msg.After, int(req.Msg.Limit))
	if err != nil {
		slog.Error("listing members", "err", err, "user", userID, "server", req.Msg.ServerId)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	protoMembers := make([]*v1.Member, len(members))
	for i, m := range members {
		protoMembers[i] = memberToProto(m)
	}

	return connect.NewResponse(&v1.ListMembersResponse{
		Members: protoMembers,
	}), nil
}

func (s *chatService) UpdateMember(ctx context.Context, req *connect.Request[v1.UpdateMemberRequest]) (*connect.Response[v1.UpdateMemberResponse], error) {
	// 1. Authenticate.
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing user"))
	}

	// 2. Validate.
	if req.Msg.ServerId == "" || req.Msg.UserId == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("server_id and user_id are required"))
	}

	if req.Msg.Nickname == nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("no changes requested"))
	}

	// Validate nickname length and content.
	if *req.Msg.Nickname != "" {
		nick := *req.Msg.Nickname
		if len(nick) > 32 {
			return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("nickname must be 32 characters or fewer"))
		}
		for _, r := range nick {
			if r < 0x20 || r == 0x7F {
				return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("nickname must not contain control characters"))
			}
		}
	}

	// 3. Membership — caller must be a member.
	if err := s.requireMembership(ctx, userID, req.Msg.ServerId); err != nil {
		return nil, err
	}

	// 4. Target must be a member.
	targetIsMember, err := s.chatStore.IsMember(ctx, req.Msg.UserId, req.Msg.ServerId)
	if err != nil {
		slog.Error("checking target membership", "err", err, "user", req.Msg.UserId, "server", req.Msg.ServerId)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}
	if !targetIsMember {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("user is not a member of this server"))
	}

	srv, err := s.chatStore.GetServer(ctx, req.Msg.ServerId)
	if err != nil {
		slog.Error("getting server", "err", err, "server", req.Msg.ServerId)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	// --- Nickname handling ---
	if req.Msg.UserId == userID {
		// Self-nickname change: require ChangeNickname.
		perms, permErr := s.resolvePermissions(ctx, userID, req.Msg.ServerId, "")
		if permErr != nil {
			return nil, permErr
		}
		if !permissions.Has(perms, permissions.ChangeNickname) {
			return nil, connect.NewError(connect.CodePermissionDenied, errors.New("missing ChangeNickname permission"))
		}
	} else {
		// Changing another's nickname: require ManageNicknames + hierarchy.
		perms, permErr := s.resolvePermissions(ctx, userID, req.Msg.ServerId, "")
		if permErr != nil {
			return nil, permErr
		}
		if !permissions.Has(perms, permissions.ManageNicknames) {
			return nil, connect.NewError(connect.CodePermissionDenied, errors.New("missing ManageNicknames permission"))
		}
		// Owner protection.
		if srv.OwnerID == req.Msg.UserId && userID != srv.OwnerID {
			return nil, connect.NewError(connect.CodePermissionDenied, errors.New("cannot modify the server owner's nickname"))
		}
		// Hierarchy check (skip for owner — owner outranks everyone).
		if userID != srv.OwnerID {
			callerPos, cpErr := s.getEffectivePosition(ctx, userID, req.Msg.ServerId)
			if cpErr != nil {
				return nil, cpErr
			}
			targetPos, tpErr := s.getEffectivePosition(ctx, req.Msg.UserId, req.Msg.ServerId)
			if tpErr != nil {
				return nil, tpErr
			}
			if callerPos <= targetPos {
				return nil, connect.NewError(connect.CodePermissionDenied, errors.New("cannot modify nickname of a member with equal or higher role"))
			}
		}
	}
	if err := s.chatStore.SetMemberNickname(ctx, req.Msg.ServerId, req.Msg.UserId, *req.Msg.Nickname); err != nil {
		slog.Error("setting member nickname", "err", err, "user", req.Msg.UserId, "server", req.Msg.ServerId)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	// Response — fetch updated member.
	member, err := s.chatStore.GetMember(ctx, req.Msg.UserId, req.Msg.ServerId)
	if err != nil {
		slog.Error("getting member after update", "err", err, "user", req.Msg.UserId, "server", req.Msg.ServerId)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}
	memberProto := memberToProto(member)

	// Event — publish MEMBER_UPDATE via NATS.
	event := &v1.Event{
		Id:        models.NewID(),
		Type:      v1.EventType_EVENT_TYPE_MEMBER_UPDATE,
		Timestamp: timestamppb.New(time.Now()),
		Payload: &v1.Event_MemberUpdate{
			MemberUpdate: memberProto,
		},
	}
	eventData, err := proto.Marshal(event)
	if err != nil {
		slog.Error("marshaling event", "err", err)
	} else {
		s.nc.Publish(subjects.ServerMember(req.Msg.ServerId), eventData)
	}

	return connect.NewResponse(&v1.UpdateMemberResponse{
		Member: memberProto,
	}), nil
}

func (s *chatService) SetMemberRoles(ctx context.Context, req *connect.Request[v1.SetMemberRolesRequest]) (*connect.Response[v1.SetMemberRolesResponse], error) {
	// 1. Authenticate.
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing user"))
	}

	// 2. Validate.
	if req.Msg.ServerId == "" || req.Msg.UserId == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("server_id and user_id are required"))
	}
	if len(req.Msg.RoleIds) > 250 {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("too many role_ids (max 250)"))
	}

	// 3. Membership — caller must be a member.
	if err := s.requireMembership(ctx, userID, req.Msg.ServerId); err != nil {
		return nil, err
	}

	// 4. Target must be a member.
	targetIsMember, err := s.chatStore.IsMember(ctx, req.Msg.UserId, req.Msg.ServerId)
	if err != nil {
		slog.Error("checking target membership", "err", err, "user", req.Msg.UserId, "server", req.Msg.ServerId)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}
	if !targetIsMember {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("user is not a member of this server"))
	}

	// Permission — require ManageRoles; returns callerPos, callerPerms.
	callerPos, callerPerms, srv, permErr := s.requirePermission(ctx, userID, req.Msg.ServerId, permissions.ManageRoles)
	if permErr != nil {
		return nil, permErr
	}

	// Owner protection: non-owners cannot modify the owner's roles.
	if srv.OwnerID == req.Msg.UserId && userID != srv.OwnerID {
		return nil, connect.NewError(connect.CodePermissionDenied, errors.New("cannot modify the server owner's roles"))
	}

	// Self-assignment block: non-owners cannot assign roles to themselves.
	if req.Msg.UserId == userID && userID != srv.OwnerID {
		return nil, connect.NewError(connect.CodePermissionDenied, errors.New("cannot modify your own roles"))
	}

	// Deduplicate role IDs.
	seen := make(map[string]struct{}, len(req.Msg.RoleIds))
	dedupedRoleIDs := make([]string, 0, len(req.Msg.RoleIds))
	for _, id := range req.Msg.RoleIds {
		if _, exists := seen[id]; !exists {
			seen[id] = struct{}{}
			dedupedRoleIDs = append(dedupedRoleIDs, id)
		}
	}

	// Hierarchy — batch fetch roles; verify all exist and all are below caller.
	if len(dedupedRoleIDs) > 0 {
		roles, err := s.roleStore.GetRolesByIDs(ctx, dedupedRoleIDs, req.Msg.ServerId)
		if err != nil {
			slog.Error("getting roles by ids", "err", err, "server", req.Msg.ServerId)
			return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
		}
		if len(roles) != len(dedupedRoleIDs) {
			return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("one or more role_ids are invalid"))
		}

		// Owner bypasses hierarchy and escalation checks (callerPos is math.MaxInt32).
		if userID != srv.OwnerID {
			for _, r := range roles {
				if r.Position >= callerPos {
					return nil, connect.NewError(connect.CodePermissionDenied, errors.New("cannot assign a role with equal or higher position"))
				}
			}

			// No-escalation — assigned permissions must be a subset of caller's permissions.
			var assignedPerms int64
			for _, r := range roles {
				assignedPerms |= r.Permissions
			}
			effectiveCallerPerms := callerPerms
			if permissions.Has(callerPerms, permissions.Administrator) {
				effectiveCallerPerms = permissions.AllPermissions
			}
			escalated := assignedPerms & ^effectiveCallerPerms
			if escalated != 0 {
				return nil, connect.NewError(connect.CodePermissionDenied, errors.New("cannot assign roles with permissions you do not have"))
			}
		}
	}

	// Mutation — set member roles.
	if err := s.roleStore.SetMemberRoles(ctx, req.Msg.UserId, req.Msg.ServerId, dedupedRoleIDs); err != nil {
		slog.Error("setting member roles", "err", err, "user", req.Msg.UserId, "server", req.Msg.ServerId)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	// Invalidate permission cache for the affected user.
	s.permCache.InvalidateUser(ctx, req.Msg.UserId, req.Msg.ServerId)

	// Publish PERMISSIONS_UPDATED signal (role assignment affects permissions).
	s.publishPermissionsUpdated(ctx, req.Msg.ServerId, "")

	// Response — fetch updated member.
	member, err := s.chatStore.GetMember(ctx, req.Msg.UserId, req.Msg.ServerId)
	if err != nil {
		slog.Error("getting member after role update", "err", err, "user", req.Msg.UserId, "server", req.Msg.ServerId)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}
	memberProto := memberToProto(member)

	// Event — publish MEMBER_UPDATE via NATS.
	event := &v1.Event{
		Id:        models.NewID(),
		Type:      v1.EventType_EVENT_TYPE_MEMBER_UPDATE,
		Timestamp: timestamppb.New(time.Now()),
		Payload: &v1.Event_MemberUpdate{
			MemberUpdate: memberProto,
		},
	}
	eventData, err := proto.Marshal(event)
	if err != nil {
		slog.Error("marshaling event", "err", err)
	} else {
		s.nc.Publish(subjects.ServerMember(req.Msg.ServerId), eventData)
	}

	return connect.NewResponse(&v1.SetMemberRolesResponse{
		Member: memberProto,
	}), nil
}

func (s *chatService) KickMember(ctx context.Context, req *connect.Request[v1.KickMemberRequest]) (*connect.Response[v1.KickMemberResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing user"))
	}
	if req.Msg.ServerId == "" || req.Msg.UserId == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("server_id and user_id are required"))
	}

	if err := s.requireMembership(ctx, userID, req.Msg.ServerId); err != nil {
		return nil, err
	}

	callerPos, _, srv, err := s.requirePermission(ctx, userID, req.Msg.ServerId, permissions.KickMembers)
	if err != nil {
		return nil, err
	}

	// Cannot kick yourself.
	if req.Msg.UserId == userID {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("cannot kick yourself"))
	}

	// Cannot kick the server owner.
	if srv.OwnerID == req.Msg.UserId {
		return nil, connect.NewError(connect.CodePermissionDenied, errors.New("cannot kick the server owner"))
	}

	// Verify target is actually a member.
	targetIsMember, err := s.chatStore.IsMember(ctx, req.Msg.UserId, req.Msg.ServerId)
	if err != nil {
		slog.Error("checking target membership", "err", err, "user", req.Msg.UserId, "server", req.Msg.ServerId)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}
	if !targetIsMember {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("user is not a member of this server"))
	}

	// Hierarchy check: caller must outrank target.
	targetPos, err := s.getEffectivePosition(ctx, req.Msg.UserId, req.Msg.ServerId)
	if err != nil {
		return nil, err
	}
	if callerPos <= targetPos {
		return nil, connect.NewError(connect.CodePermissionDenied, errors.New("cannot kick a member with equal or higher role"))
	}

	if err := s.chatStore.RemoveMember(ctx, req.Msg.UserId, req.Msg.ServerId); err != nil {
		slog.Error("removing member", "err", err, "user", req.Msg.UserId, "server", req.Msg.ServerId)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	// Clean up channel_members for the kicked user in this server.
	if err := s.chatStore.RemoveChannelMembersForServer(ctx, req.Msg.UserId, req.Msg.ServerId); err != nil {
		slog.Error("removing channel members for kicked user", "err", err, "user", req.Msg.UserId, "server", req.Msg.ServerId)
	}

	// Publish member remove event.
	event := &v1.Event{
		Id:        models.NewID(),
		Type:      v1.EventType_EVENT_TYPE_MEMBER_REMOVE,
		Timestamp: timestamppb.New(time.Now()),
		Payload: &v1.Event_MemberRemove{
			MemberRemove: &v1.MemberRemoveEvent{
				ServerId: req.Msg.ServerId,
				UserId:   req.Msg.UserId,
			},
		},
	}
	eventData, err := proto.Marshal(event)
	if err != nil {
		slog.Error("marshaling event", "err", err)
	} else {
		if err := s.nc.Publish(subjects.ServerMember(req.Msg.ServerId), eventData); err != nil {
			slog.Warn("nats publish failed", "subject", subjects.ServerMember(req.Msg.ServerId), "err", err)
		}
	}

	// Signal gateway to refresh channel subscriptions for the kicked user.
	s.nc.Publish(subjects.UserSubscription(req.Msg.UserId), nil)

	return connect.NewResponse(&v1.KickMemberResponse{}), nil
}

// --- Ban handlers ---

func (s *chatService) BanMember(ctx context.Context, req *connect.Request[v1.BanMemberRequest]) (*connect.Response[v1.BanMemberResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing user"))
	}
	if req.Msg.ServerId == "" || req.Msg.UserId == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("server_id and user_id are required"))
	}

	if err := s.requireMembership(ctx, userID, req.Msg.ServerId); err != nil {
		return nil, err
	}

	callerPos, _, srv, err := s.requirePermission(ctx, userID, req.Msg.ServerId, permissions.BanMembers)
	if err != nil {
		return nil, err
	}

	// Cannot ban yourself.
	if req.Msg.UserId == userID {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("cannot ban yourself"))
	}

	// Cannot ban the server owner.
	if srv.OwnerID == req.Msg.UserId {
		return nil, connect.NewError(connect.CodePermissionDenied, errors.New("cannot ban the server owner"))
	}

	// Check if already banned.
	alreadyBanned, err := s.banStore.IsBanned(ctx, req.Msg.ServerId, req.Msg.UserId)
	if err != nil {
		slog.Error("checking ban", "err", err, "user", req.Msg.UserId, "server", req.Msg.ServerId)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}
	if alreadyBanned {
		return nil, connect.NewError(connect.CodeAlreadyExists, errors.New("user is already banned"))
	}

	ban := &models.Ban{
		ServerID:  req.Msg.ServerId,
		UserID:    req.Msg.UserId,
		Reason:    req.Msg.GetReason(),
		BannedBy:  &userID,
		CreatedAt: time.Now(),
	}

	// Check if target is a member of the server.
	isMember, err := s.chatStore.IsMember(ctx, req.Msg.UserId, req.Msg.ServerId)
	if err != nil {
		slog.Error("checking membership", "err", err, "user", req.Msg.UserId, "server", req.Msg.ServerId)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	if isMember {
		// Target is a member — enforce hierarchy and atomically ban + remove.
		targetPos, err := s.getEffectivePosition(ctx, req.Msg.UserId, req.Msg.ServerId)
		if err != nil {
			return nil, err
		}
		if callerPos <= targetPos {
			return nil, connect.NewError(connect.CodePermissionDenied, errors.New("cannot ban a member with equal or higher role"))
		}

		if err := s.banStore.CreateBanAndRemoveMember(ctx, ban, callerPos); err != nil {
			slog.Error("banning member", "err", err, "user", req.Msg.UserId, "server", req.Msg.ServerId)
			return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
		}

		// Clean up channel_members for the banned user in this server.
		if err := s.chatStore.RemoveChannelMembersForServer(ctx, req.Msg.UserId, req.Msg.ServerId); err != nil {
			slog.Error("removing channel members for banned user", "err", err, "user", req.Msg.UserId, "server", req.Msg.ServerId)
		}

		// Publish member remove event.
		event := &v1.Event{
			Id:        models.NewID(),
			Type:      v1.EventType_EVENT_TYPE_MEMBER_REMOVE,
			Timestamp: timestamppb.New(time.Now()),
			Payload: &v1.Event_MemberRemove{
				MemberRemove: &v1.MemberRemoveEvent{
					ServerId: req.Msg.ServerId,
					UserId:   req.Msg.UserId,
				},
			},
		}
		eventData, err := proto.Marshal(event)
		if err != nil {
			slog.Error("marshaling event", "err", err)
		} else {
			if err := s.nc.Publish(subjects.ServerMember(req.Msg.ServerId), eventData); err != nil {
				slog.Warn("nats publish failed", "subject", subjects.ServerMember(req.Msg.ServerId), "err", err)
			}
		}

		// Signal gateway to refresh channel subscriptions for the banned user.
		s.nc.Publish(subjects.UserSubscription(req.Msg.UserId), nil)
	} else {
		// Pre-emptive ban — no hierarchy check needed.
		created, err := s.banStore.CreateBan(ctx, ban)
		if err != nil {
			slog.Error("creating ban", "err", err, "user", req.Msg.UserId, "server", req.Msg.ServerId)
			return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
		}
		if !created {
			return nil, connect.NewError(connect.CodeAlreadyExists, errors.New("user is already banned"))
		}
	}

	return connect.NewResponse(&v1.BanMemberResponse{}), nil
}

func (s *chatService) UnbanMember(ctx context.Context, req *connect.Request[v1.UnbanMemberRequest]) (*connect.Response[v1.UnbanMemberResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing user"))
	}
	if req.Msg.ServerId == "" || req.Msg.UserId == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("server_id and user_id are required"))
	}

	if err := s.requireMembership(ctx, userID, req.Msg.ServerId); err != nil {
		return nil, err
	}

	if _, _, _, err := s.requirePermission(ctx, userID, req.Msg.ServerId, permissions.BanMembers); err != nil {
		return nil, err
	}

	// Verify the user is actually banned.
	isBanned, err := s.banStore.IsBanned(ctx, req.Msg.ServerId, req.Msg.UserId)
	if err != nil {
		slog.Error("checking ban", "err", err, "user", req.Msg.UserId, "server", req.Msg.ServerId)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}
	if !isBanned {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("user is not banned"))
	}

	if err := s.banStore.DeleteBan(ctx, req.Msg.ServerId, req.Msg.UserId); err != nil {
		slog.Error("deleting ban", "err", err, "user", req.Msg.UserId, "server", req.Msg.ServerId)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	return connect.NewResponse(&v1.UnbanMemberResponse{}), nil
}

func (s *chatService) ListBans(ctx context.Context, req *connect.Request[v1.ListBansRequest]) (*connect.Response[v1.ListBansResponse], error) {
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

	if _, _, _, err := s.requirePermission(ctx, userID, req.Msg.ServerId, permissions.BanMembers); err != nil {
		return nil, err
	}

	bans, err := s.banStore.ListBans(ctx, req.Msg.ServerId)
	if err != nil {
		slog.Error("listing bans", "err", err, "server", req.Msg.ServerId)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	protoBans := make([]*v1.Ban, len(bans))
	for i, b := range bans {
		protoBans[i] = banToProto(b)
	}

	return connect.NewResponse(&v1.ListBansResponse{
		Bans: protoBans,
	}), nil
}

// --- Role handlers ---

func (s *chatService) CreateRole(ctx context.Context, req *connect.Request[v1.CreateRoleRequest]) (*connect.Response[v1.CreateRoleResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing user"))
	}
	if req.Msg.ServerId == "" || req.Msg.Name == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("server_id and name are required"))
	}

	if err := s.requireMembership(ctx, userID, req.Msg.ServerId); err != nil {
		return nil, err
	}

	_, callerPerms, srv, err := s.requirePermission(ctx, userID, req.Msg.ServerId, permissions.ManageRoles)
	if err != nil {
		return nil, err
	}

	// Validate permissions if provided.
	if req.Msg.Permissions != 0 && !permissions.Validate(req.Msg.Permissions) {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("invalid permissions"))
	}

	// Non-owner escalation check: cannot create a role with permissions the caller does not have.
	if req.Msg.Permissions != 0 && userID != srv.OwnerID {
		effectiveCallerPerms := callerPerms
		if permissions.Has(callerPerms, permissions.Administrator) {
			effectiveCallerPerms = permissions.AllPermissions
		}
		escalated := req.Msg.Permissions & ^effectiveCallerPerms
		if escalated != 0 {
			return nil, connect.NewError(connect.CodePermissionDenied, errors.New("cannot set permissions you do not have"))
		}
	}

	role := &models.Role{
		ID:               models.NewID(),
		ServerID:         req.Msg.ServerId,
		Name:             req.Msg.Name,
		Permissions:      req.Msg.Permissions,
		Color:            int(req.Msg.Color),
		IsSelfAssignable: req.Msg.IsSelfAssignable,
		CreatedAt:        time.Now(),
	}

	created, err := s.roleStore.CreateRole(ctx, role)
	if err != nil {
		slog.Error("creating role", "err", err, "user", userID, "server", req.Msg.ServerId)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	// Broadcast role create event.
	event := &v1.Event{
		Id:        models.NewID(),
		Type:      v1.EventType_EVENT_TYPE_ROLE_CREATE,
		Timestamp: timestamppb.New(time.Now()),
		Payload: &v1.Event_RoleCreate{
			RoleCreate: roleToProto(created),
		},
	}
	eventData, err := proto.Marshal(event)
	if err != nil {
		slog.Error("marshaling event", "err", err)
	} else {
		s.nc.Publish(subjects.ServerRole(req.Msg.ServerId), eventData)
	}

	return connect.NewResponse(&v1.CreateRoleResponse{
		Role: roleToProto(created),
	}), nil
}

func (s *chatService) UpdateRole(ctx context.Context, req *connect.Request[v1.UpdateRoleRequest]) (*connect.Response[v1.UpdateRoleResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing user"))
	}
	if req.Msg.RoleId == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("role_id is required"))
	}

	// Look up role to get server_id (IDOR prevention).
	role, err := s.roleStore.GetRole(ctx, req.Msg.RoleId)
	if err != nil {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("role not found"))
	}

	if err := s.requireMembership(ctx, userID, role.ServerID); err != nil {
		return nil, err
	}

	callerPos, callerPerms, srv, err := s.requirePermission(ctx, userID, role.ServerID, permissions.ManageRoles)
	if err != nil {
		return nil, err
	}

	// @everyone role protection: cannot change name.
	if role.ID == role.ServerID {
		if req.Msg.Name != nil {
			return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("cannot rename the @everyone role"))
		}
	}

	// Hierarchy check: caller must outrank the role being edited.
	// @everyone is position 0, so any role holder outranks it — this is correct.
	if callerPos <= role.Position {
		return nil, connect.NewError(connect.CodePermissionDenied, errors.New("cannot modify a role with equal or higher position"))
	}

	// Validate permissions if provided.
	if req.Msg.Permissions != nil && !permissions.Validate(*req.Msg.Permissions) {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("invalid permissions"))
	}

	// Non-owner escalation checks.
	if userID != srv.OwnerID {
		// Cannot set permissions the caller does not have.
		if req.Msg.Permissions != nil {
			effectiveCallerPerms := callerPerms
			if permissions.Has(callerPerms, permissions.Administrator) {
				effectiveCallerPerms = permissions.AllPermissions
			}
			escalated := *req.Msg.Permissions & ^effectiveCallerPerms
			if escalated != 0 {
				return nil, connect.NewError(connect.CodePermissionDenied, errors.New("cannot set permissions you do not have"))
			}
		}
	}

	var name *string
	var perms *int64
	var color *int
	var isSelfAssignable *bool
	if req.Msg.Name != nil {
		name = req.Msg.Name
	}
	if req.Msg.Permissions != nil {
		perms = req.Msg.Permissions
	}
	if req.Msg.Color != nil {
		c := int(*req.Msg.Color)
		color = &c
	}
	if req.Msg.IsSelfAssignable != nil {
		isSelfAssignable = req.Msg.IsSelfAssignable
	}

	updated, err := s.roleStore.UpdateRole(ctx, req.Msg.RoleId, name, perms, color, isSelfAssignable)
	if err != nil {
		slog.Error("updating role", "err", err, "user", userID, "role", req.Msg.RoleId)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	// Invalidate permission cache for entire server (role change affects all members with this role).
	s.permCache.InvalidateServer(ctx, role.ServerID)

	// Broadcast role update event.
	event := &v1.Event{
		Id:        models.NewID(),
		Type:      v1.EventType_EVENT_TYPE_ROLE_UPDATE,
		Timestamp: timestamppb.New(time.Now()),
		Payload: &v1.Event_RoleUpdate{
			RoleUpdate: roleToProto(updated),
		},
	}
	eventData, err := proto.Marshal(event)
	if err != nil {
		slog.Error("marshaling event", "err", err)
	} else {
		s.nc.Publish(subjects.ServerRole(role.ServerID), eventData)
	}

	// Publish PERMISSIONS_UPDATED signal (role change affects permissions).
	s.publishPermissionsUpdated(ctx, role.ServerID, "")

	return connect.NewResponse(&v1.UpdateRoleResponse{
		Role: roleToProto(updated),
	}), nil
}

func (s *chatService) DeleteRole(ctx context.Context, req *connect.Request[v1.DeleteRoleRequest]) (*connect.Response[v1.DeleteRoleResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing user"))
	}
	if req.Msg.RoleId == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("role_id is required"))
	}

	// Look up role to get server_id (IDOR prevention).
	role, err := s.roleStore.GetRole(ctx, req.Msg.RoleId)
	if err != nil {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("role not found"))
	}

	if err := s.requireMembership(ctx, userID, role.ServerID); err != nil {
		return nil, err
	}

	callerPos, _, _, err := s.requirePermission(ctx, userID, role.ServerID, permissions.ManageRoles)
	if err != nil {
		return nil, err
	}

	// Cannot delete the @everyone role.
	if role.ID == role.ServerID {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("cannot delete the @everyone role"))
	}

	// Hierarchy check: caller must outrank the role being deleted.
	if callerPos <= role.Position {
		return nil, connect.NewError(connect.CodePermissionDenied, errors.New("cannot delete a role with equal or higher position"))
	}

	if err := s.roleStore.DeleteRole(ctx, req.Msg.RoleId); err != nil {
		slog.Error("deleting role", "err", err, "user", userID, "role", req.Msg.RoleId)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	// Invalidate permission cache for entire server (role deletion affects all members with this role).
	s.permCache.InvalidateServer(ctx, role.ServerID)

	// Broadcast role delete event.
	event := &v1.Event{
		Id:        models.NewID(),
		Type:      v1.EventType_EVENT_TYPE_ROLE_DELETE,
		Timestamp: timestamppb.New(time.Now()),
		Payload: &v1.Event_RoleDelete{
			RoleDelete: &v1.RoleDeleteEvent{
				ServerId: role.ServerID,
				RoleId:   req.Msg.RoleId,
			},
		},
	}
	eventData, err := proto.Marshal(event)
	if err != nil {
		slog.Error("marshaling event", "err", err)
	} else {
		s.nc.Publish(subjects.ServerRole(role.ServerID), eventData)
	}

	// Publish PERMISSIONS_UPDATED signal (role deletion affects permissions).
	s.publishPermissionsUpdated(ctx, role.ServerID, "")

	return connect.NewResponse(&v1.DeleteRoleResponse{}), nil
}

func (s *chatService) ListRoles(ctx context.Context, req *connect.Request[v1.ListRolesRequest]) (*connect.Response[v1.ListRolesResponse], error) {
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

	roles, err := s.roleStore.ListRoles(ctx, req.Msg.ServerId)
	if err != nil {
		slog.Error("listing roles", "err", err, "server", req.Msg.ServerId)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	protoRoles := make([]*v1.Role, len(roles))
	for i, r := range roles {
		protoRoles[i] = roleToProto(r)
	}

	return connect.NewResponse(&v1.ListRolesResponse{
		Roles: protoRoles,
	}), nil
}

func (s *chatService) ReorderRoles(ctx context.Context, req *connect.Request[v1.ReorderRolesRequest]) (*connect.Response[v1.ReorderRolesResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing user"))
	}
	if req.Msg.ServerId == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("server_id is required"))
	}
	if len(req.Msg.RoleIds) == 0 {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("role_ids is required"))
	}
	if len(req.Msg.RoleIds) > 250 {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("too many role_ids (max 250)"))
	}

	if err := s.requireMembership(ctx, userID, req.Msg.ServerId); err != nil {
		return nil, err
	}

	callerPos, _, srv, err := s.requirePermission(ctx, userID, req.Msg.ServerId, permissions.ManageRoles)
	if err != nil {
		return nil, err
	}

	// Owner uses math.MaxInt32 as effective position (outranks everything).
	if userID == srv.OwnerID {
		callerPos = int(^uint(0) >> 1) // math.MaxInt
	}

	// Deduplicate role IDs.
	seen := make(map[string]struct{}, len(req.Msg.RoleIds))
	dedupedRoleIDs := make([]string, 0, len(req.Msg.RoleIds))
	for _, id := range req.Msg.RoleIds {
		if id == req.Msg.ServerId {
			return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("@everyone role cannot be reordered"))
		}
		if _, exists := seen[id]; !exists {
			seen[id] = struct{}{}
			dedupedRoleIDs = append(dedupedRoleIDs, id)
		}
	}

	// Store handles: locking, TOCTOU-safe hierarchy re-check, completeness verification,
	// position assignment, and above-caller role shifting.
	roles, err := s.roleStore.ReorderRoles(ctx, req.Msg.ServerId, dedupedRoleIDs, callerPos)
	if err != nil {
		errMsg := err.Error()
		if strings.Contains(errMsg, "must contain all") || strings.Contains(errMsg, "not below your position") {
			return nil, connect.NewError(connect.CodeInvalidArgument, err)
		}
		slog.Error("reordering roles", "err", err, "user", userID, "server", req.Msg.ServerId)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	// Invalidate permission cache for entire server.
	s.permCache.InvalidateServer(ctx, req.Msg.ServerId)

	// Broadcast single ROLES_REORDERED event with full role list.
	protoRoles := make([]*v1.Role, len(roles))
	for i, r := range roles {
		protoRoles[i] = roleToProto(r)
	}
	event := &v1.Event{
		Id:        models.NewID(),
		Type:      v1.EventType_EVENT_TYPE_ROLES_REORDERED,
		Timestamp: timestamppb.New(time.Now()),
		Payload: &v1.Event_RolesReordered{
			RolesReordered: &v1.RolesReorderedEvent{
				ServerId: req.Msg.ServerId,
				Roles:    protoRoles,
			},
		},
	}
	eventData, err := proto.Marshal(event)
	if err != nil {
		slog.Error("marshaling event", "err", err)
	} else {
		s.nc.Publish(subjects.ServerRole(req.Msg.ServerId), eventData)
	}

	return connect.NewResponse(&v1.ReorderRolesResponse{}), nil
}

// --- Proto conversion helpers ---

func roleToProto(r *models.Role) *v1.Role {
	return &v1.Role{
		Id:               r.ID,
		ServerId:         r.ServerID,
		Name:             r.Name,
		Permissions:      r.Permissions,
		Color:            int32(r.Color),
		Position:         int32(r.Position),
		IsSelfAssignable: r.IsSelfAssignable,
	}
}

func banToProto(b *models.Ban) *v1.Ban {
	ban := &v1.Ban{
		ServerId:  b.ServerID,
		UserId:    b.UserID,
		CreatedAt: timestamppb.New(b.CreatedAt),
	}
	if b.Reason != "" {
		ban.Reason = b.Reason
	}
	if b.BannedBy != nil {
		ban.BannedBy = *b.BannedBy
	}
	return ban
}

func memberToProto(m *models.Member) *v1.Member {
	pm := &v1.Member{
		UserId:   m.UserID,
		ServerId: m.ServerID,
		RoleIds:  m.RoleIDs,
		Nickname: m.Nickname,
		JoinedAt: timestamppb.New(m.JoinedAt),
	}
	if m.TimedOutUntil != nil {
		pm.TimedOutUntil = timestamppb.New(*m.TimedOutUntil)
	}
	if m.OnboardingCompletedAt != nil {
		pm.OnboardingCompletedAt = timestamppb.New(*m.OnboardingCompletedAt)
	}
	if m.RulesAcknowledgedAt != nil {
		pm.RulesAcknowledgedAt = timestamppb.New(*m.RulesAcknowledgedAt)
	}
	return pm
}

// --- Stub handlers for new RPCs (to be implemented in later phases) ---

// BulkDeleteMessages is not yet implemented. When implemented, it must also
// clean up message_replies entries for each deleted message that has a reply_to_id.
func (s *chatService) BulkDeleteMessages(context.Context, *connect.Request[v1.BulkDeleteMessagesRequest]) (*connect.Response[v1.BulkDeleteMessagesResponse], error) {
	return nil, connect.NewError(connect.CodeUnimplemented, errors.New("not implemented"))
}

func (s *chatService) TimeoutMember(ctx context.Context, req *connect.Request[v1.TimeoutMemberRequest]) (*connect.Response[v1.TimeoutMemberResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing user"))
	}
	if req.Msg.ServerId == "" || req.Msg.UserId == "" || req.Msg.TimedOutUntil == nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("server_id, user_id, and timed_out_until are required"))
	}

	if err := s.requireMembership(ctx, userID, req.Msg.ServerId); err != nil {
		return nil, err
	}

	// Cannot timeout yourself.
	if req.Msg.UserId == userID {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("cannot timeout yourself"))
	}

	callerPos, _, srv, err := s.requirePermission(ctx, userID, req.Msg.ServerId, permissions.TimeoutMembers)
	if err != nil {
		return nil, err
	}

	// Owner is immune to timeouts.
	if srv.OwnerID == req.Msg.UserId {
		return nil, connect.NewError(connect.CodePermissionDenied, errors.New("cannot timeout the server owner"))
	}

	// Verify target is a member.
	targetIsMember, err := s.chatStore.IsMember(ctx, req.Msg.UserId, req.Msg.ServerId)
	if err != nil {
		slog.Error("checking target membership", "err", err, "user", req.Msg.UserId, "server", req.Msg.ServerId)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}
	if !targetIsMember {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("user is not a member of this server"))
	}

	// Hierarchy check: caller must outrank target.
	targetPos, err := s.getEffectivePosition(ctx, req.Msg.UserId, req.Msg.ServerId)
	if err != nil {
		return nil, err
	}
	if callerPos <= targetPos {
		return nil, connect.NewError(connect.CodePermissionDenied, errors.New("cannot timeout a member with equal or higher role"))
	}

	// Validate duration: max 28 days.
	timedOutUntil := req.Msg.TimedOutUntil.AsTime()
	maxTimeout := time.Now().Add(28 * 24 * time.Hour)
	if timedOutUntil.After(maxTimeout) {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("timeout duration cannot exceed 28 days"))
	}
	if timedOutUntil.Before(time.Now()) {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("timed_out_until must be in the future"))
	}

	// Set timeout in DB.
	if err := s.chatStore.SetMemberTimeout(ctx, req.Msg.ServerId, req.Msg.UserId, &timedOutUntil); err != nil {
		slog.Error("setting member timeout", "err", err, "user", req.Msg.UserId, "server", req.Msg.ServerId)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	// Invalidate permission cache for the timed-out user.
	s.permCache.InvalidateUser(ctx, req.Msg.UserId, req.Msg.ServerId)

	// Fetch updated member for response and event.
	member, err := s.chatStore.GetMember(ctx, req.Msg.UserId, req.Msg.ServerId)
	if err != nil {
		slog.Error("getting member after timeout", "err", err, "user", req.Msg.UserId, "server", req.Msg.ServerId)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}
	memberProto := memberToProto(member)

	// Publish MEMBER_UPDATE event.
	event := &v1.Event{
		Id:        models.NewID(),
		Type:      v1.EventType_EVENT_TYPE_MEMBER_UPDATE,
		Timestamp: timestamppb.New(time.Now()),
		Payload:   &v1.Event_MemberUpdate{MemberUpdate: memberProto},
	}
	eventData, err := proto.Marshal(event)
	if err != nil {
		slog.Error("marshaling event", "err", err)
	} else {
		s.nc.Publish(subjects.ServerMember(req.Msg.ServerId), eventData)
	}

	// Publish PERMISSIONS_UPDATED signal (timeout affects permissions).
	s.publishPermissionsUpdated(ctx, req.Msg.ServerId, "")

	return connect.NewResponse(&v1.TimeoutMemberResponse{
		Member: memberProto,
	}), nil
}

func (s *chatService) RemoveTimeout(ctx context.Context, req *connect.Request[v1.RemoveTimeoutRequest]) (*connect.Response[v1.RemoveTimeoutResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing user"))
	}
	if req.Msg.ServerId == "" || req.Msg.UserId == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("server_id and user_id are required"))
	}

	if err := s.requireMembership(ctx, userID, req.Msg.ServerId); err != nil {
		return nil, err
	}

	callerPos, _, _, err := s.requirePermission(ctx, userID, req.Msg.ServerId, permissions.TimeoutMembers)
	if err != nil {
		return nil, err
	}

	// Verify target is a member.
	targetIsMember, err := s.chatStore.IsMember(ctx, req.Msg.UserId, req.Msg.ServerId)
	if err != nil {
		slog.Error("checking target membership", "err", err, "user", req.Msg.UserId, "server", req.Msg.ServerId)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}
	if !targetIsMember {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("user is not a member of this server"))
	}

	// Hierarchy check: caller must outrank the target (consistent with TimeoutMember).
	targetPos, posErr := s.getEffectivePosition(ctx, req.Msg.UserId, req.Msg.ServerId)
	if posErr != nil {
		return nil, posErr
	}
	if callerPos <= targetPos {
		return nil, connect.NewError(connect.CodePermissionDenied, errors.New("cannot remove timeout of a member with equal or higher role"))
	}

	// Clear timeout in DB.
	if err := s.chatStore.SetMemberTimeout(ctx, req.Msg.ServerId, req.Msg.UserId, nil); err != nil {
		slog.Error("removing member timeout", "err", err, "user", req.Msg.UserId, "server", req.Msg.ServerId)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	// Invalidate permission cache for the user.
	s.permCache.InvalidateUser(ctx, req.Msg.UserId, req.Msg.ServerId)

	// Fetch updated member for response and event.
	member, err := s.chatStore.GetMember(ctx, req.Msg.UserId, req.Msg.ServerId)
	if err != nil {
		slog.Error("getting member after timeout removal", "err", err, "user", req.Msg.UserId, "server", req.Msg.ServerId)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}
	memberProto := memberToProto(member)

	// Publish MEMBER_UPDATE event.
	event := &v1.Event{
		Id:        models.NewID(),
		Type:      v1.EventType_EVENT_TYPE_MEMBER_UPDATE,
		Timestamp: timestamppb.New(time.Now()),
		Payload:   &v1.Event_MemberUpdate{MemberUpdate: memberProto},
	}
	eventData, err := proto.Marshal(event)
	if err != nil {
		slog.Error("marshaling event", "err", err)
	} else {
		s.nc.Publish(subjects.ServerMember(req.Msg.ServerId), eventData)
	}

	// Publish PERMISSIONS_UPDATED signal (timeout removal affects permissions).
	s.publishPermissionsUpdated(ctx, req.Msg.ServerId, "")

	return connect.NewResponse(&v1.RemoveTimeoutResponse{
		Member: memberProto,
	}), nil
}

func (s *chatService) ListAuditLog(context.Context, *connect.Request[v1.ListAuditLogRequest]) (*connect.Response[v1.ListAuditLogResponse], error) {
	return nil, connect.NewError(connect.CodeUnimplemented, errors.New("not implemented"))
}
