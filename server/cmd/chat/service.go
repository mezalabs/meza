package main

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"regexp"
	"strings"
	"time"

	"connectrpc.com/connect"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/nats-io/nats.go"
	"github.com/redis/go-redis/v9"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/meza-chat/meza/gen/meza/v1"
	"github.com/meza-chat/meza/internal/auth"
	"github.com/meza-chat/meza/internal/embed"
	"github.com/meza-chat/meza/internal/models"
	"github.com/meza-chat/meza/internal/permissions"
	"github.com/meza-chat/meza/internal/search"
	"github.com/meza-chat/meza/internal/store"
	"github.com/meza-chat/meza/internal/subjects"
)

var validULID = regexp.MustCompile(`^[0-9A-Z]{26}$`)

// Searcher abstracts the search backend so tests can inject a mock.
type Searcher interface {
	IndexMessage(doc search.MessageDocument)
	UpdateMessage(doc search.MessageDocument)
	DeleteMessage(messageID string)
	DeleteChannelMessages(channelID string)
	Search(params search.SearchParams) ([]search.SearchResult, int64, error)
}

// EncryptionChecker checks whether a channel has been set up for E2EE.
// Used as a defense-in-depth measure to reject plaintext messages on encrypted channels.
type EncryptionChecker interface {
	HasChannelKeyVersion(ctx context.Context, channelID string) (bool, error)
}

// validateServerName checks that a server name is non-empty, not whitespace-only,
// within length limits, and free of null bytes or HTML tags.
func validateServerName(name string) error {
	if name == "" || strings.TrimSpace(name) == "" {
		return connect.NewError(connect.CodeInvalidArgument, errors.New("name is required"))
	}
	if len(name) > 100 {
		return connect.NewError(connect.CodeInvalidArgument, errors.New("name exceeds 100 characters"))
	}
	if strings.ContainsRune(name, 0) {
		return connect.NewError(connect.CodeInvalidArgument, errors.New("name contains invalid characters"))
	}
	if strings.Contains(name, "<") && strings.Contains(name, ">") {
		return connect.NewError(connect.CodeInvalidArgument, errors.New("name contains invalid characters"))
	}
	return nil
}

type chatService struct {
	pool                    *pgxpool.Pool
	chatStore               store.ChatStorer
	messageStore            store.MessageStorer
	inviteStore             store.InviteStorer
	roleStore               store.RoleStorer
	banStore                store.BanStorer
	pinStore                store.PinStorer
	emojiStore              store.EmojiStorer
	auditStore              store.AuditLogStorer
	soundboardStore         store.SoundboardStorer
	reactionStore           store.ReactionStorer
	readStateStore          store.ReadStateStorer
	authStore               store.AuthStorer
	blockStore              store.BlockStorer
	friendStore             store.FriendStorer
	mediaStore              store.MediaStorer
	linkPreviewStore        store.LinkPreviewStorer
	channelGroupStore       store.ChannelGroupStorer
	permissionOverrideStore store.PermissionOverrideStorer
	encryptionChecker       EncryptionChecker
	nc                      *nats.Conn
	rdb                     *redis.Client
	permCache               *permissions.Cache
	searchClient            Searcher
}

type chatServiceConfig struct {
	Pool                    *pgxpool.Pool
	ChatStore               store.ChatStorer
	MessageStore            store.MessageStorer
	InviteStore             store.InviteStorer
	RoleStore               store.RoleStorer
	BanStore                store.BanStorer
	PinStore                store.PinStorer
	EmojiStore              store.EmojiStorer
	AuditStore              store.AuditLogStorer
	SoundboardStore         store.SoundboardStorer
	ReactionStore           store.ReactionStorer
	ReadStateStore          store.ReadStateStorer
	AuthStore               store.AuthStorer
	BlockStore              store.BlockStorer
	FriendStore             store.FriendStorer
	MediaStore              store.MediaStorer
	LinkPreviewStore        store.LinkPreviewStorer
	ChannelGroupStore       store.ChannelGroupStorer
	PermissionOverrideStore store.PermissionOverrideStorer
	EncryptionChecker       EncryptionChecker
	NC                      *nats.Conn
	RDB                     *redis.Client
	PermCache               *permissions.Cache
	SearchClient            Searcher
}

func newChatService(cfg chatServiceConfig) *chatService {
	return &chatService{
		pool:                    cfg.Pool,
		chatStore:               cfg.ChatStore,
		messageStore:            cfg.MessageStore,
		inviteStore:             cfg.InviteStore,
		roleStore:               cfg.RoleStore,
		banStore:                cfg.BanStore,
		pinStore:                cfg.PinStore,
		emojiStore:              cfg.EmojiStore,
		auditStore:              cfg.AuditStore,
		soundboardStore:         cfg.SoundboardStore,
		reactionStore:           cfg.ReactionStore,
		readStateStore:          cfg.ReadStateStore,
		authStore:               cfg.AuthStore,
		blockStore:              cfg.BlockStore,
		friendStore:             cfg.FriendStore,
		mediaStore:              cfg.MediaStore,
		linkPreviewStore:        cfg.LinkPreviewStore,
		channelGroupStore:       cfg.ChannelGroupStore,
		permissionOverrideStore: cfg.PermissionOverrideStore,
		encryptionChecker:       cfg.EncryptionChecker,
		nc:                      cfg.NC,
		rdb:                     cfg.RDB,
		permCache:               cfg.PermCache,
		searchClient:            cfg.SearchClient,
	}
}

func (s *chatService) requireMembership(ctx context.Context, userID, serverID string) error {
	if serverID == "" {
		return nil // DM channels have no server; access checked via GetChannelAndCheckMembership
	}
	isMember, err := s.chatStore.IsMember(ctx, userID, serverID)
	if err != nil {
		slog.Error("checking membership", "err", err, "user", userID, "server", serverID)
		return connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}
	if !isMember {
		return connect.NewError(connect.CodePermissionDenied, errors.New("not a member of this server"))
	}
	return nil
}

func (s *chatService) isDMChannel(ch *models.Channel) bool {
	return ch.Type == 3
}

// isServerlessChannel returns true for any channel without a server (1-on-1 DMs and group DMs).
func (s *chatService) isServerlessChannel(ch *models.Channel) bool {
	return ch.ServerID == ""
}

// requirePermission checks that the caller has the given permission in the server.
// Returns the caller's maximum role position (for hierarchy checks), the caller's
// combined permissions, and the server.
func (s *chatService) requirePermission(ctx context.Context, userID, serverID string, perm int64) (int, int64, *models.Server, error) {
	roles, err := s.roleStore.GetMemberRoles(ctx, userID, serverID)
	if err != nil {
		slog.Error("getting member roles", "err", err, "user", userID, "server", serverID)
		return 0, 0, nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	// Also check if user is server owner — owner has all permissions implicitly.
	srv, err := s.chatStore.GetServer(ctx, serverID)
	if err != nil {
		slog.Error("getting server", "err", err, "server", serverID)
		return 0, 0, nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}
	if srv.OwnerID == userID {
		return math.MaxInt32, permissions.AllPermissions, srv, nil // Owner outranks everyone
	}

	var combined int64
	var maxPos int
	for _, r := range roles {
		combined |= r.Permissions
		if r.Position > maxPos {
			maxPos = r.Position
		}
	}
	if !permissions.Has(combined, perm) {
		return 0, 0, nil, connect.NewError(connect.CodePermissionDenied, errors.New("missing permission"))
	}
	return maxPos, combined, srv, nil
}

// hasPermission returns true if the user has the given permission in the server.
// Unlike requirePermission, this does not return an error on missing permission —
// it returns false. On internal errors, it returns false (fail-closed).
func (s *chatService) hasPermission(ctx context.Context, userID, serverID string, perm int64) bool {
	_, combined, _, err := s.requirePermission(ctx, userID, serverID, perm)
	if err != nil {
		return false
	}
	return permissions.Has(combined, perm)
}

// getEffectivePermissions returns the combined permission bitfield for a user in a server
// by OR-ing all their role permissions. Server owners receive AllPermissions.
// Unlike requirePermission, this does not check for a specific permission — it returns
// the full combined bitfield. On internal errors, it returns 0 and an error.
func (s *chatService) getEffectivePermissions(ctx context.Context, userID, serverID string) (int64, error) {
	roles, err := s.roleStore.GetMemberRoles(ctx, userID, serverID)
	if err != nil {
		slog.Error("getting member roles", "err", err, "user", userID, "server", serverID)
		return 0, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	// Server owner gets all permissions.
	srv, err := s.chatStore.GetServer(ctx, serverID)
	if err != nil {
		slog.Error("getting server", "err", err, "server", serverID)
		return 0, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}
	if srv.OwnerID == userID {
		return permissions.AllPermissions, nil
	}

	// Combine role permissions via bitwise OR.
	var combined int64
	for _, r := range roles {
		combined |= r.Permissions
	}
	return combined, nil
}

// resolvePermissions computes effective permissions for a user in a server+channel context.
// If channelID is empty, returns server-level permissions (no overrides applied).
func (s *chatService) resolvePermissions(ctx context.Context, userID, serverID, channelID string) (int64, error) {
	// Check cache first.
	if cached, ok := s.permCache.Get(ctx, userID, serverID, channelID); ok {
		return cached, nil
	}

	// 1. Get server (for owner check).
	srv, err := s.chatStore.GetServer(ctx, serverID)
	if err != nil {
		slog.Error("getting server for permissions", "err", err, "server", serverID)
		return 0, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	// 2. Get @everyone role (id = serverID).
	everyoneRole, err := s.roleStore.GetRole(ctx, serverID)
	if err != nil {
		slog.Error("getting everyone role", "err", err, "server", serverID)
		return 0, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	// 3. Get member (for roleIDs + timed_out_until).
	member, err := s.chatStore.GetMember(ctx, userID, serverID)
	if err != nil {
		slog.Error("getting member for permissions", "err", err, "user", userID, "server", serverID)
		return 0, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	// 4. Get role permissions for member's assigned roles.
	var rolePerms []int64
	if len(member.RoleIDs) > 0 {
		roles, err := s.roleStore.GetRolesByIDs(ctx, member.RoleIDs, serverID)
		if err != nil {
			slog.Error("getting member roles for permissions", "err", err, "user", userID, "server", serverID)
			return 0, connect.NewError(connect.CodeInternal, errors.New("internal error"))
		}
		rolePerms = make([]int64, len(roles))
		for i, r := range roles {
			rolePerms[i] = r.Permissions
		}
	}

	// Build timeout value.
	var timedOutUntil int64
	if member.TimedOutUntil != nil {
		timedOutUntil = member.TimedOutUntil.Unix()
	}

	input := permissions.ResolveInput{
		EveryonePerms: everyoneRole.Permissions,
		RolePerms:     rolePerms,
		IsOwner:       srv.OwnerID == userID,
		TimedOutUntil: timedOutUntil,
	}

	// 5. If channelID provided, get overrides (both role and user-level).
	if channelID != "" {
		// Include @everyone role ID (= serverID) in override lookup.
		allRoleIDs := append([]string{serverID}, member.RoleIDs...)
		overrides, err := s.permissionOverrideStore.GetAllOverridesForChannel(ctx, channelID, allRoleIDs, userID)
		if err != nil {
			slog.Error("getting overrides for permissions", "err", err, "channel", channelID)
			return 0, connect.NewError(connect.CodeInternal, errors.New("internal error"))
		}

		input.GroupRoleOverrides = overrides.GroupRoleOverrides
		input.ChannelRoleOverrides = overrides.ChannelRoleOverrides
		input.GroupUserOverride = overrides.GroupUserOverride
		input.ChannelUserOverride = overrides.ChannelUserOverride
	}

	result := permissions.ResolveEffective(input, time.Now().Unix())
	s.permCache.Set(ctx, userID, serverID, channelID, result)
	return result, nil
}

// resolvePermissionSources computes permission source attribution for a user.
// This re-fetches the same data as resolvePermissions but passes it through
// AttributeSources instead of ResolveEffective.
func (s *chatService) resolvePermissionSources(ctx context.Context, userID, serverID, channelID string) ([]*v1.PermissionSource, error) {
	// 1. Get server (for owner check).
	srv, err := s.chatStore.GetServer(ctx, serverID)
	if err != nil {
		return nil, fmt.Errorf("get server: %w", err)
	}

	// 2. Get @everyone role.
	everyoneRole, err := s.roleStore.GetRole(ctx, serverID)
	if err != nil {
		return nil, fmt.Errorf("get everyone role: %w", err)
	}

	// 3. Get member.
	member, err := s.chatStore.GetMember(ctx, userID, serverID)
	if err != nil {
		return nil, fmt.Errorf("get member: %w", err)
	}

	// 4. Get role permissions + names.
	var rolePerms []int64
	var roleNames []string
	if len(member.RoleIDs) > 0 {
		roles, err := s.roleStore.GetRolesByIDs(ctx, member.RoleIDs, serverID)
		if err != nil {
			return nil, fmt.Errorf("get member roles: %w", err)
		}
		rolePerms = make([]int64, len(roles))
		roleNames = make([]string, len(roles))
		for i, r := range roles {
			rolePerms[i] = r.Permissions
			roleNames[i] = r.Name
		}
	}

	var timedOutUntil int64
	if member.TimedOutUntil != nil {
		timedOutUntil = member.TimedOutUntil.Unix()
	}

	input := permissions.AttributeSourcesInput{
		ResolveInput: permissions.ResolveInput{
			EveryonePerms: everyoneRole.Permissions,
			RolePerms:     rolePerms,
			IsOwner:       srv.OwnerID == userID,
			TimedOutUntil: timedOutUntil,
		},
		EveryoneName: "@everyone",
		RoleNames:    roleNames,
	}

	// 5. Channel overrides.
	if channelID != "" {
		allRoleIDs := append([]string{serverID}, member.RoleIDs...)
		overrides, err := s.permissionOverrideStore.GetAllOverridesForChannel(ctx, channelID, allRoleIDs, userID)
		if err != nil {
			return nil, fmt.Errorf("get overrides: %w", err)
		}
		input.GroupRoleOverrides = overrides.GroupRoleOverrides
		input.ChannelRoleOverrides = overrides.ChannelRoleOverrides
		input.GroupUserOverride = overrides.GroupUserOverride
		input.ChannelUserOverride = overrides.ChannelUserOverride
	}

	sources := permissions.AttributeSources(input, time.Now().Unix())

	// Convert to proto.
	protoSources := make([]*v1.PermissionSource, len(sources))
	for i, src := range sources {
		protoSources[i] = &v1.PermissionSource{
			Permission: src.Permission,
			Granted:    src.Granted,
			SourceType: v1.PermissionSourceType(src.SourceType),
			SourceName: src.SourceName,
		}
	}
	return protoSources, nil
}

// resolvePermissionsBatch computes effective permissions for a user across multiple channels
// in the same server. Common data (server, member, roles) is fetched once and all channel
// overrides are fetched in a single batch query. Results are cached per channel.
func (s *chatService) resolvePermissionsBatch(ctx context.Context, userID, serverID string, channelIDs []string) (map[string]int64, error) {
	result := make(map[string]int64, len(channelIDs))

	// Check cache first for all channels.
	var uncached []string
	for _, chID := range channelIDs {
		if cached, ok := s.permCache.Get(ctx, userID, serverID, chID); ok {
			result[chID] = cached
		} else {
			uncached = append(uncached, chID)
		}
	}
	if len(uncached) == 0 {
		return result, nil
	}

	// Fetch common data once.
	srv, err := s.chatStore.GetServer(ctx, serverID)
	if err != nil {
		slog.Error("getting server for batch permissions", "err", err, "server", serverID)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	everyoneRole, err := s.roleStore.GetRole(ctx, serverID)
	if err != nil {
		slog.Error("getting everyone role for batch permissions", "err", err, "server", serverID)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	member, err := s.chatStore.GetMember(ctx, userID, serverID)
	if err != nil {
		slog.Error("getting member for batch permissions", "err", err, "user", userID, "server", serverID)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	var rolePerms []int64
	if len(member.RoleIDs) > 0 {
		roles, err := s.roleStore.GetRolesByIDs(ctx, member.RoleIDs, serverID)
		if err != nil {
			slog.Error("getting member roles for batch permissions", "err", err, "user", userID, "server", serverID)
			return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
		}
		rolePerms = make([]int64, len(roles))
		for i, r := range roles {
			rolePerms[i] = r.Permissions
		}
	}

	var timedOutUntil int64
	if member.TimedOutUntil != nil {
		timedOutUntil = member.TimedOutUntil.Unix()
	}

	allRoleIDs := append([]string{serverID}, member.RoleIDs...)
	nowUnix := time.Now().Unix()

	// Fetch all channel overrides in a single batch query instead of N sequential queries.
	allOverrides, err := s.permissionOverrideStore.GetAllOverridesForChannels(ctx, uncached, allRoleIDs, userID)
	if err != nil {
		slog.Error("getting batch overrides for permissions", "err", err, "server", serverID)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	// Resolve each uncached channel using the pre-fetched overrides.
	for _, chID := range uncached {
		input := permissions.ResolveInput{
			EveryonePerms: everyoneRole.Permissions,
			RolePerms:     rolePerms,
			IsOwner:       srv.OwnerID == userID,
			TimedOutUntil: timedOutUntil,
		}

		if overrides, ok := allOverrides[chID]; ok {
			input.GroupRoleOverrides = overrides.GroupRoleOverrides
			input.ChannelRoleOverrides = overrides.ChannelRoleOverrides
			input.GroupUserOverride = overrides.GroupUserOverride
			input.ChannelUserOverride = overrides.ChannelUserOverride
		}

		perms := permissions.ResolveEffective(input, nowUnix)
		s.permCache.Set(ctx, userID, serverID, chID, perms)
		result[chID] = perms
	}

	return result, nil
}

// publishPermissionsUpdated publishes a PERMISSIONS_UPDATED event to notify clients
// that permissions have changed. channelID may be empty for server-level changes.
func (s *chatService) publishPermissionsUpdated(_ context.Context, serverID, channelID string) {
	event := &v1.Event{
		Id:        models.NewID(),
		Type:      v1.EventType_EVENT_TYPE_PERMISSIONS_UPDATED,
		Timestamp: timestamppb.New(time.Now()),
		Payload: &v1.Event_PermissionsUpdated{
			PermissionsUpdated: &v1.PermissionsUpdatedEvent{
				ServerId:  serverID,
				ChannelId: channelID,
			},
		},
	}
	if data, err := proto.Marshal(event); err == nil {
		s.nc.Publish(subjects.ServerRole(serverID), data)
	}
}

// getEffectivePosition returns the maximum role position of a target user in a server.
func (s *chatService) getEffectivePosition(ctx context.Context, userID, serverID string) (int, error) {
	roles, err := s.roleStore.GetMemberRoles(ctx, userID, serverID)
	if err != nil {
		slog.Error("getting target roles", "err", err, "user", userID, "server", serverID)
		return 0, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}
	var maxPos int
	for _, r := range roles {
		if r.Position > maxPos {
			maxPos = r.Position
		}
	}
	return maxPos, nil
}

// requireChannelAccess checks that the user can access a channel.
// For public channels, uses ViewChannel permission resolution.
// For private channels, requires channel membership, server owner, or Administrator.
// DM/group DM access is verified separately by GetChannelAndCheckMembership.
func (s *chatService) requireChannelAccess(ctx context.Context, ch *models.Channel, userID string) error {
	if s.isServerlessChannel(ch) {
		return nil // DM/group DM access is verified by GetChannelAndCheckMembership
	}

	// Private channels gate on channel membership (+ owner/admin bypass).
	if ch.IsPrivate {
		isChanMember, err := s.chatStore.IsChannelMember(ctx, ch.ID, userID)
		if err != nil {
			slog.Error("checking channel membership", "err", err, "user", userID, "channel", ch.ID)
			return connect.NewError(connect.CodeInternal, errors.New("internal error"))
		}
		if isChanMember {
			return nil
		}

		// Check if server owner.
		srv, err := s.chatStore.GetServer(ctx, ch.ServerID)
		if err != nil {
			slog.Error("getting server for channel access", "err", err, "server", ch.ServerID)
			return connect.NewError(connect.CodeInternal, errors.New("internal error"))
		}
		if srv.OwnerID == userID {
			return nil
		}

		// Check if user has Administrator permission.
		roles, err := s.roleStore.GetMemberRoles(ctx, userID, ch.ServerID)
		if err != nil {
			slog.Error("getting member roles for channel access", "err", err, "user", userID)
			return connect.NewError(connect.CodeInternal, errors.New("internal error"))
		}
		var combined int64
		for _, r := range roles {
			combined |= r.Permissions
		}
		if permissions.Has(combined, permissions.Administrator) {
			return nil
		}

		return connect.NewError(connect.CodePermissionDenied, errors.New("no access to this channel"))
	}

	// Public channels use ViewChannel permission resolution.
	resolved, err := s.resolvePermissions(ctx, userID, ch.ServerID, ch.ID)
	if err != nil {
		slog.Error("resolving permissions for channel access", "err", err, "user", userID, "channel", ch.ID)
		return connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}
	if !permissions.Has(resolved, permissions.ViewChannel) {
		return connect.NewError(connect.CodePermissionDenied, errors.New("no access to this channel"))
	}
	return nil
}

func (s *chatService) CreateServer(ctx context.Context, req *connect.Request[v1.CreateServerRequest]) (*connect.Response[v1.CreateServerResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing user"))
	}
	if err := validateServerName(req.Msg.Name); err != nil {
		return nil, err
	}

	var iconURL *string
	if req.Msg.IconUrl != nil && *req.Msg.IconUrl != "" {
		iconURL = req.Msg.IconUrl
	}

	srv, err := s.chatStore.CreateServer(ctx, req.Msg.Name, userID, iconURL, req.Msg.DefaultChannelPrivacy)
	if err != nil {
		slog.Error("creating server", "err", err, "user", userID)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	return connect.NewResponse(&v1.CreateServerResponse{
		Server: serverToProto(srv),
	}), nil
}

func (s *chatService) CreateServerFromTemplate(ctx context.Context, req *connect.Request[v1.CreateServerFromTemplateRequest]) (*connect.Response[v1.CreateServerFromTemplateResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing user"))
	}
	if err := validateServerName(req.Msg.Name); err != nil {
		return nil, err
	}
	if len(req.Msg.Channels) == 0 {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("at least one channel is required"))
	}

	// Validate onboarding fields.
	if req.Msg.WelcomeMessage != nil && len(*req.Msg.WelcomeMessage) > 5000 {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("welcome_message exceeds 5000 characters"))
	}
	if req.Msg.Rules != nil {
		lines := strings.Split(*req.Msg.Rules, "\n")
		if len(lines) > 25 {
			return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("rules exceed 25 lines"))
		}
	}
	if req.Msg.RulesRequired && !req.Msg.OnboardingEnabled {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("rules_required requires onboarding_enabled"))
	}

	// Map proto channel specs to store params.
	channelSpecs := make([]store.TemplateChannelSpec, len(req.Msg.Channels))
	for i, ch := range req.Msg.Channels {
		if ch.Name == "" {
			return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("channel %d: name is required", i))
		}
		channelSpecs[i] = store.TemplateChannelSpec{
			Name:      ch.Name,
			Type:      int(ch.Type),
			IsDefault: ch.IsDefault,
			IsPrivate: ch.IsPrivate,
			RoleNames: ch.RoleNames,
		}
	}

	// Map proto role specs to store params.
	roleSpecs := make([]store.TemplateRoleSpec, len(req.Msg.Roles))
	for i, r := range req.Msg.Roles {
		if r.Name == "" {
			return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("role %d: name is required", i))
		}
		roleSpecs[i] = store.TemplateRoleSpec{
			Name:             r.Name,
			Permissions:      r.Permissions,
			Color:            int(r.Color),
			IsSelfAssignable: r.IsSelfAssignable,
		}
	}

	var iconURL *string
	if req.Msg.IconUrl != nil {
		iconURL = req.Msg.IconUrl
	}
	var welcomeMessage *string
	if req.Msg.WelcomeMessage != nil {
		welcomeMessage = req.Msg.WelcomeMessage
	}
	var rules *string
	if req.Msg.Rules != nil {
		rules = req.Msg.Rules
	}

	srv, channels, roles, err := s.chatStore.CreateServerFromTemplate(ctx, store.CreateServerFromTemplateParams{
		Name:              req.Msg.Name,
		IconURL:           iconURL,
		OwnerID:           userID,
		WelcomeMessage:    welcomeMessage,
		Rules:             rules,
		OnboardingEnabled: req.Msg.OnboardingEnabled,
		RulesRequired:     req.Msg.RulesRequired,
		Channels:          channelSpecs,
		Roles:             roleSpecs,
	})
	if err != nil {
		slog.Error("creating server from template", "err", err, "user", userID)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	// Create a default invite (unlimited uses, 7-day expiry).
	expiresAt := time.Now().Add(7 * 24 * time.Hour)
	inv, err := s.inviteStore.CreateInvite(ctx, srv.ID, userID, 0, &expiresAt)
	if err != nil {
		slog.Error("creating invite for new server", "err", err, "user", userID, "server", srv.ID)
		// Non-fatal: server was created successfully, invite is a bonus.
		inv = nil
	}

	// Auto-add owner as channel member for all template channels (key distribution tracking for E2EE).
	for _, ch := range channels {
		if err := s.chatStore.AddChannelMember(ctx, ch.ID, userID); err != nil {
			slog.Error("adding owner to template channel", "err", err, "user", userID, "channel", ch.ID)
		}
	}
	// Signal gateway to refresh channel subscriptions for the new server's channels.
	s.nc.Publish(subjects.UserSubscription(userID), nil)

	// Build response.
	protoChannels := make([]*v1.Channel, len(channels))
	for i, ch := range channels {
		protoChannels[i] = channelToProto(ch)
	}
	protoRoles := make([]*v1.Role, len(roles))
	for i, r := range roles {
		protoRoles[i] = roleToProto(r)
	}

	resp := &v1.CreateServerFromTemplateResponse{
		Server:   serverToProto(srv),
		Channels: protoChannels,
		Roles:    protoRoles,
	}
	if inv != nil {
		resp.Invite = inviteToProto(inv)
	}

	return connect.NewResponse(resp), nil
}

func (s *chatService) CreateChannel(ctx context.Context, req *connect.Request[v1.CreateChannelRequest]) (*connect.Response[v1.CreateChannelResponse], error) {
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

	// Require ManageChannels permission (or Administrator/owner).
	_, _, _, permErr := s.requirePermission(ctx, userID, req.Msg.ServerId, permissions.ManageChannels)
	if permErr != nil {
		return nil, permErr
	}

	// Validate channel group belongs to the same server.
	if gid := req.Msg.GetChannelGroupId(); gid != "" {
		group, err := s.channelGroupStore.GetChannelGroup(ctx, gid)
		if err != nil {
			return nil, connect.NewError(connect.CodeNotFound, errors.New("channel group not found"))
		}
		if group.ServerID != req.Msg.ServerId {
			return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("channel group does not belong to this server"))
		}
	}

	// Apply server default privacy if the client didn't explicitly set is_private.
	isPrivate := req.Msg.IsPrivate
	if !isPrivate {
		srv, err := s.chatStore.GetServer(ctx, req.Msg.ServerId)
		if err != nil {
			slog.Error("getting server for default privacy", "err", err, "server", req.Msg.ServerId)
			return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
		}
		isPrivate = srv.DefaultChannelPrivacy
	}

	ch, err := s.chatStore.CreateChannel(ctx, req.Msg.ServerId, req.Msg.Name, int(req.Msg.Type), isPrivate, req.Msg.GetChannelGroupId())
	if err != nil {
		if errors.Is(err, store.ErrAlreadyExists) {
			return nil, connect.NewError(connect.CodeAlreadyExists, errors.New("a channel with that name already exists"))
		}
		slog.Error("creating channel", "err", err, "user", userID, "server", req.Msg.ServerId)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	// Auto-add creator as channel member (key distribution tracking for E2EE).
	if err := s.chatStore.AddChannelMember(ctx, ch.ID, userID); err != nil {
		slog.Error("adding channel creator as member", "err", err, "user", userID, "channel", ch.ID)
		// Channel was created, so don't fail the whole operation.
	} else {
		// Signal gateway to refresh channel subscriptions for the creator.
		s.nc.Publish(subjects.UserSubscription(userID), nil)
	}

	// Private channels: deny ViewChannel on @everyone so only explicit members can see it.
	if ch.IsPrivate {
		everyoneRoleID := req.Msg.ServerId // @everyone role ID = server ID
		denyOverride := &models.PermissionOverride{
			ID:        models.NewID(),
			ChannelID: ch.ID,
			RoleID:    everyoneRoleID,
			Allow:     0,
			Deny:      permissions.ViewChannel,
		}
		if _, err := s.permissionOverrideStore.SetOverride(ctx, denyOverride); err != nil {
			slog.Error("setting ViewChannel deny for private channel", "err", err, "channel", ch.ID)
		}
	}

	// Copy category permission overrides as initial channel overrides.
	if gid := req.Msg.GetChannelGroupId(); gid != "" {
		categoryOverrides, err := s.permissionOverrideStore.ListOverridesByTarget(ctx, gid)
		if err != nil {
			slog.Error("listing category overrides for inheritance", "err", err, "group", gid)
			// Non-fatal: channel was created, overrides are best-effort.
		} else {
			for _, ovr := range categoryOverrides {
				channelOverride := &models.PermissionOverride{
					ID:        models.NewID(),
					ChannelID: ch.ID,
					RoleID:    ovr.RoleID,
					Allow:     ovr.Allow,
					Deny:      ovr.Deny,
				}
				if _, err := s.permissionOverrideStore.SetOverride(ctx, channelOverride); err != nil {
					slog.Error("copying category override to channel", "err", err, "channel", ch.ID, "role", ovr.RoleID)
				}
			}
		}
	}

	// Broadcast channel create event.
	now := time.Now()
	event := &v1.Event{
		Id:        models.NewID(),
		Type:      v1.EventType_EVENT_TYPE_CHANNEL_CREATE,
		Timestamp: timestamppb.New(now),
		Payload: &v1.Event_ChannelCreate{
			ChannelCreate: channelToProto(ch),
		},
	}
	eventData, err := proto.Marshal(event)
	if err != nil {
		slog.Error("marshaling event", "err", err)
		// Don't return error - the DB mutation succeeded, event broadcast is best-effort
	} else {
		// Encode privacy prefix to avoid full deserialization in gateway (TODO 270).
		privateChID := ""
		if ch.IsPrivate {
			privateChID = ch.ID
		}
		s.nc.Publish(subjects.ServerChannel(req.Msg.ServerId), subjects.EncodeServerChannelEvent(eventData, privateChID))
	}

	return connect.NewResponse(&v1.CreateChannelResponse{
		Channel: channelToProto(ch),
	}), nil
}

func (s *chatService) SendMessage(ctx context.Context, req *connect.Request[v1.SendMessageRequest]) (*connect.Response[v1.SendMessageResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing user"))
	}
	if req.Msg.ChannelId == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("channel_id is required"))
	}
	if len(req.Msg.EncryptedContent) > 16000 {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("message content too large"))
	}

	// Combined channel lookup + membership check in a single query
	ch, isMember, err := s.chatStore.GetChannelAndCheckMembership(ctx, req.Msg.ChannelId, userID)
	if err != nil {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("channel not found"))
	}
	if !isMember {
		return nil, connect.NewError(connect.CodePermissionDenied, errors.New("not a member of this server"))
	}

	// DM-specific guards: block check and pending/declined status.
	if s.isDMChannel(ch) {
		otherID, err := s.chatStore.GetDMOtherParticipantID(ctx, ch.ID, userID)
		if err != nil {
			slog.Error("getting DM other participant", "err", err, "channel", ch.ID)
			return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
		}

		blocked, err := s.blockStore.IsBlockedEither(ctx, userID, otherID)
		if err != nil {
			slog.Error("checking block in SendMessage", "err", err, "user", userID, "other", otherID)
			return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
		}
		if blocked {
			return nil, errUnableToMessage
		}

		// Pending channel: only the initiator (sender) can send messages.
		// The recipient must accept before replying.
		if ch.DMStatus == "pending" && ch.DMInitiatorID != userID {
			return nil, connect.NewError(connect.CodePermissionDenied, errors.New("accept this message request before replying"))
		}
	}

	// Check private channel access.
	if err := s.requireChannelAccess(ctx, ch, userID); err != nil {
		return nil, err
	}

	// Permission + rules checks (server channels only; DMs skip).
	var channelPerms int64
	if ch.ServerID != "" {
		resolved, permErr := s.resolvePermissions(ctx, userID, ch.ServerID, ch.ID)
		if permErr != nil {
			return nil, permErr
		}
		channelPerms = resolved
		if !permissions.Has(channelPerms, permissions.SendMessages) {
			return nil, connect.NewError(connect.CodePermissionDenied, errors.New("missing SendMessages permission"))
		}
		if len(req.Msg.AttachmentIds) > 0 && !permissions.Has(channelPerms, permissions.AttachFiles) {
			return nil, connect.NewError(connect.CodePermissionDenied, errors.New("missing AttachFiles permission"))
		}

		// Check rules acknowledgement if required.
		srv, srvErr := s.chatStore.GetServer(ctx, ch.ServerID)
		if srvErr != nil {
			slog.Error("getting server for rules check", "err", srvErr, "server", ch.ServerID)
			return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
		}
		if srv.RulesRequired {
			acknowledged, ackErr := s.chatStore.CheckRulesAcknowledged(ctx, userID, srv.ID)
			if ackErr != nil {
				slog.Error("checking rules acknowledgement", "err", ackErr, "user", userID, "server", srv.ID)
				return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
			}
			if !acknowledged {
				return nil, connect.NewError(connect.CodePermissionDenied,
					errors.New("you must acknowledge server rules before sending messages"))
			}
		}
	}

	// Defense-in-depth: reject plaintext (keyVersion=0) on encrypted channels.
	if req.Msg.GetKeyVersion() == 0 && s.encryptionChecker != nil {
		encrypted, encErr := s.encryptionChecker.HasChannelKeyVersion(ctx, req.Msg.ChannelId)
		if encErr != nil {
			slog.Error("checking channel encryption status", "err", encErr, "channel", req.Msg.ChannelId)
			return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
		}
		if encrypted {
			return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("encrypted channel requires keyVersion > 0"))
		}
	}

	// Validate and hydrate attachments.
	var protoAttachments []*v1.Attachment
	if len(req.Msg.AttachmentIds) > 0 {
		if len(req.Msg.AttachmentIds) > 10 {
			return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("max 10 attachments per message"))
		}
		attachments, err := s.mediaStore.GetAttachmentsByIDs(ctx, req.Msg.AttachmentIds)
		if err != nil {
			slog.Error("fetching attachments", "err", err, "user", userID)
			return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
		}
		if len(attachments) != len(req.Msg.AttachmentIds) {
			return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("one or more attachment IDs are invalid"))
		}
		for _, a := range attachments {
			if a.Status != models.AttachmentStatusCompleted {
				return nil, connect.NewError(connect.CodeFailedPrecondition, errors.New("one or more attachments are still processing"))
			}
			if a.UploaderID != userID {
				return nil, connect.NewError(connect.CodePermissionDenied, errors.New("attachment not owned by sender"))
			}
		}
		// Build proto attachments in request order.
		protoAttachments = make([]*v1.Attachment, 0, len(req.Msg.AttachmentIds))
		for _, id := range req.Msg.AttachmentIds {
			if a, ok := attachments[id]; ok {
				protoAttachments = append(protoAttachments, attachmentToProto(a))
			}
		}
	}

	// Validate reply_to_id if set.
	replyToID := req.Msg.GetReplyToId()
	if replyToID != "" {
		if len(replyToID) > 26 {
			return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("reply_to_id is invalid"))
		}
		parent, err := s.messageStore.GetMessage(ctx, req.Msg.ChannelId, replyToID)
		if err != nil {
			return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("reply_to_id references a nonexistent message"))
		}
		if parent.Deleted {
			return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("reply_to_id references a deleted message"))
		}
	}

	// --- Mention validation ---

	mentionedUserIDs := req.Msg.MentionedUserIds
	mentionedRoleIDs := req.Msg.MentionedRoleIds
	mentionEveryone := req.Msg.MentionEveryone

	// Strip @everyone and role mentions for DM channels (no server context, no permissions).
	if ch.ServerID == "" {
		mentionEveryone = false
		mentionedRoleIDs = nil
	}

	// Validate and sanitize mentioned_user_ids.
	if len(mentionedUserIDs) > 100 {
		return nil, connect.NewError(connect.CodeInvalidArgument,
			errors.New("max 100 mentions per message"))
	}

	// Validate ULID format, deduplicate, and filter self-mention.
	seen := make(map[string]struct{}, len(mentionedUserIDs))
	filtered := make([]string, 0, len(mentionedUserIDs))
	for _, uid := range mentionedUserIDs {
		if !validULID.MatchString(uid) {
			return nil, connect.NewError(connect.CodeInvalidArgument,
				fmt.Errorf("invalid mention user ID: %s", uid))
		}
		if uid == userID { // filter self-mention
			continue
		}
		if _, ok := seen[uid]; !ok {
			seen[uid] = struct{}{}
			filtered = append(filtered, uid)
		}
	}
	mentionedUserIDs = filtered

	// Validate and deduplicate mentioned_role_ids.
	if len(mentionedRoleIDs) > 50 {
		return nil, connect.NewError(connect.CodeInvalidArgument,
			errors.New("max 50 role mentions per message"))
	}
	roleSeen := make(map[string]struct{}, len(mentionedRoleIDs))
	roleFiltered := make([]string, 0, len(mentionedRoleIDs))
	for _, rid := range mentionedRoleIDs {
		if !validULID.MatchString(rid) {
			return nil, connect.NewError(connect.CodeInvalidArgument,
				fmt.Errorf("invalid mention role ID: %s", rid))
		}
		if _, ok := roleSeen[rid]; !ok {
			roleSeen[rid] = struct{}{}
			roleFiltered = append(roleFiltered, rid)
		}
	}
	mentionedRoleIDs = roleFiltered

	// Permission check for @everyone (server channels only).
	if mentionEveryone && ch.ServerID != "" {
		if !permissions.Has(channelPerms, permissions.MentionEveryone) {
			mentionEveryone = false // silent strip
		}
	}

	now := time.Now()
	msgID := models.NewID()

	msg := &models.Message{
		ChannelID:        req.Msg.ChannelId,
		MessageID:        msgID,
		AuthorID:         userID,
		EncryptedContent: req.Msg.EncryptedContent,
		AttachmentIDs:    req.Msg.AttachmentIds,
		ReplyToID:        replyToID,
		MentionedUserIDs: mentionedUserIDs,
		MentionedRoleIDs: mentionedRoleIDs,
		MentionEveryone:  mentionEveryone,
		CreatedAt:        now,
		KeyVersion:       req.Msg.GetKeyVersion(),
	}

	if err := s.messageStore.InsertMessage(ctx, msg); err != nil {
		slog.Error("inserting message", "err", err, "user", userID, "channel", req.Msg.ChannelId)
		// Compensating rollback: if ScyllaDB insert failed, the attachments
		// are now in 'completed' state with no message referencing them.
		// Reset their status so orphan cleanup can eventually collect them.
		if len(req.Msg.AttachmentIds) > 0 {
			for _, aid := range req.Msg.AttachmentIds {
				if rErr := s.mediaStore.ResetAttachmentToPending(ctx, aid); rErr != nil {
					slog.Error("rollback attachment status", "err", rErr, "attachment", aid)
				}
			}
		}
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	// Insert reply index entry (best-effort).
	if replyToID != "" {
		if err := s.messageStore.InsertReplyIndex(ctx, req.Msg.ChannelId, replyToID, msgID, userID, now); err != nil {
			slog.Error("inserting reply index", "err", err, "channel", req.Msg.ChannelId, "reply_to", replyToID)
		}
	}

	// Publish delivery event to NATS for gateway fan-out.
	// Skip broadcast for declined DM channels (silent sender UX: messages stored but not delivered).
	skipBroadcast := s.isDMChannel(ch) && ch.DMStatus == "declined"
	event := &v1.Event{
		Id:        models.NewID(),
		Type:      v1.EventType_EVENT_TYPE_MESSAGE_CREATE,
		Timestamp: timestamppb.New(now),
		Payload: &v1.Event_MessageCreate{
			MessageCreate: messageToProto(msg, protoAttachments),
		},
	}
	eventData, err := proto.Marshal(event)
	if err != nil {
		slog.Error("marshaling event", "err", err)
		// Don't return error - the DB mutation succeeded, event broadcast is best-effort
	} else if !skipBroadcast {
		if err := s.nc.Publish(subjects.DeliverChannel(req.Msg.ChannelId), eventData); err != nil {
			slog.Warn("nats publish failed", "subject", subjects.DeliverChannel(req.Msg.ChannelId), "err", err)
		}
	}

	// Universal E2EE: all message content is ciphertext. Server-side indexing
	// and content inspection are removed. Search operates client-side only.

	return connect.NewResponse(&v1.SendMessageResponse{
		MessageId: msgID,
		CreatedAt: timestamppb.New(now),
	}), nil
}

func (s *chatService) GetMessages(ctx context.Context, req *connect.Request[v1.GetMessagesRequest]) (*connect.Response[v1.GetMessagesResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing user"))
	}
	if req.Msg.ChannelId == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("channel_id is required"))
	}

	ch, isMember, err := s.chatStore.GetChannelAndCheckMembership(ctx, req.Msg.ChannelId, userID)
	if err != nil {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("channel not found"))
	}
	if !isMember {
		return nil, connect.NewError(connect.CodePermissionDenied, errors.New("not a member"))
	}

	// Check private channel access (server channels only; DMs already verified via channel_members).
	if err := s.requireChannelAccess(ctx, ch, userID); err != nil {
		return nil, err
	}

	// Permission checks (server channels only; DMs skip).
	if ch.ServerID != "" {
		perms, permErr := s.resolvePermissions(ctx, userID, ch.ServerID, ch.ID)
		if permErr != nil {
			return nil, permErr
		}
		if !permissions.Has(perms, permissions.ViewChannel) {
			return nil, connect.NewError(connect.CodePermissionDenied, errors.New("missing ViewChannel permission"))
		}
		if !permissions.Has(perms, permissions.ReadMessageHistory) {
			return nil, connect.NewError(connect.CodePermissionDenied, errors.New("missing ReadMessageHistory permission"))
		}
	}

	// Validate mutual exclusivity of cursors
	cursorCount := 0
	if req.Msg.Before != "" {
		cursorCount++
	}
	if req.Msg.After != "" {
		cursorCount++
	}
	if req.Msg.Around != "" {
		cursorCount++
	}
	if cursorCount > 1 {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("only one of before, after, around may be set"))
	}

	messages, hasMore, err := s.messageStore.GetMessages(ctx, req.Msg.ChannelId, store.GetMessagesOpts{
		Before: req.Msg.Before,
		After:  req.Msg.After,
		Around: req.Msg.Around,
		Limit:  int(req.Msg.Limit),
	})
	if err != nil {
		slog.Error("getting messages", "err", err, "user", userID, "channel", req.Msg.ChannelId)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	protoMessages := make([]*v1.Message, len(messages))
	for i, msg := range messages {
		protoMessages[i] = messageToProto(msg, nil)
	}

	// Hydrate attachments: collect unique IDs, batch-fetch from Postgres.
	seen := make(map[string]struct{})
	var uniqueIDs []string
	for _, msg := range messages {
		for _, aid := range msg.AttachmentIDs {
			if _, ok := seen[aid]; !ok {
				seen[aid] = struct{}{}
				uniqueIDs = append(uniqueIDs, aid)
			}
		}
	}
	if len(uniqueIDs) > 0 {
		attachmentMap, err := s.mediaStore.GetAttachmentsByIDs(ctx, uniqueIDs)
		if err != nil {
			slog.Error("hydrating attachments", "err", err, "channel", req.Msg.ChannelId)
			// Non-fatal: return messages without attachments.
		} else {
			if len(attachmentMap) < len(uniqueIDs) {
				slog.Warn("some attachment IDs not found during hydration",
					"requested", len(uniqueIDs), "found", len(attachmentMap))
			}
			for i, msg := range messages {
				protoMessages[i].Attachments = toProtoAttachments(msg.AttachmentIDs, attachmentMap)
			}
		}
	}

	// Hydrate link embeds: batch-fetch from Postgres.
	var messageIDs []string
	for _, msg := range messages {
		messageIDs = append(messageIDs, msg.MessageID)
	}
	if len(messageIDs) > 0 && s.linkPreviewStore != nil {
		embedMap, err := s.linkPreviewStore.GetEmbedsForMessages(ctx, req.Msg.ChannelId, messageIDs)
		if err != nil {
			slog.Error("hydrating embeds", "err", err, "channel", req.Msg.ChannelId)
			// Non-fatal: return messages without embeds.
		} else {
			for i, msg := range messages {
				if previews, ok := embedMap[msg.MessageID]; ok {
					protoMessages[i].Embeds = embed.LinkPreviewsToProto(previews)
				}
			}
		}
	}

	return connect.NewResponse(&v1.GetMessagesResponse{
		Messages: protoMessages,
		HasMore:  hasMore,
	}), nil
}

func (s *chatService) SearchMessages(ctx context.Context, req *connect.Request[v1.SearchMessagesRequest]) (*connect.Response[v1.SearchMessagesResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing user"))
	}
	if req.Msg.Query == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("query is required"))
	}
	if s.searchClient == nil {
		return nil, connect.NewError(connect.CodeUnavailable, errors.New("search is not available"))
	}

	// Require at least one scope parameter to prevent unscoped global search.
	hasServerScope := req.Msg.ServerId != nil && *req.Msg.ServerId != ""
	hasChannelScope := req.Msg.ChannelId != nil && *req.Msg.ChannelId != ""
	if !hasServerScope && !hasChannelScope {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("server_id or channel_id is required"))
	}

	// Permission check: if scoped to a channel, verify membership.
	if req.Msg.ChannelId != nil && *req.Msg.ChannelId != "" {
		_, isMember, err := s.chatStore.GetChannelAndCheckMembership(ctx, *req.Msg.ChannelId, userID)
		if err != nil {
			return nil, connect.NewError(connect.CodeNotFound, errors.New("channel not found"))
		}
		if !isMember {
			return nil, connect.NewError(connect.CodePermissionDenied, errors.New("not a member"))
		}
	}

	// Permission check: if scoped to a server, verify membership.
	if req.Msg.ServerId != nil && *req.Msg.ServerId != "" {
		if err := s.requireMembership(ctx, userID, *req.Msg.ServerId); err != nil {
			return nil, err
		}
	}

	params := search.SearchParams{
		Query: req.Msg.Query,
		Limit: int64(req.Msg.Limit),
	}
	if req.Msg.ServerId != nil {
		params.ServerID = *req.Msg.ServerId
	}
	if req.Msg.ChannelId != nil {
		params.ChannelID = *req.Msg.ChannelId
	}
	if req.Msg.AuthorId != nil {
		params.AuthorID = *req.Msg.AuthorId
	}
	if req.Msg.HasAttachment != nil {
		ha := *req.Msg.HasAttachment
		params.HasAttachment = &ha
	}
	if req.Msg.BeforeId != nil && *req.Msg.BeforeId != "" {
		params.BeforeID = *req.Msg.BeforeId
	}

	hits, totalHits, err := s.searchClient.Search(params)
	if err != nil {
		slog.Error("search messages", "err", err, "user", userID)
		return nil, connect.NewError(connect.CodeInternal, errors.New("search failed"))
	}

	// Post-filter: check ViewChannel permission on each result's channel.
	// Collect unique channel IDs grouped by server for batch permission resolution.
	type chanKey struct {
		serverID  string
		channelID string
	}
	seen := make(map[chanKey]struct{})
	channelsByServer := make(map[string][]string)
	for _, hit := range hits {
		k := chanKey{hit.Doc.ServerID, hit.Doc.ChannelID}
		if _, ok := seen[k]; !ok {
			seen[k] = struct{}{}
			channelsByServer[hit.Doc.ServerID] = append(channelsByServer[hit.Doc.ServerID], hit.Doc.ChannelID)
		}
	}

	// Resolve permissions per server and collect accessible channel set.
	accessibleChannels := make(map[string]struct{})
	for srvID, chIDs := range channelsByServer {
		permsMap, permErr := s.resolvePermissionsBatch(ctx, userID, srvID, chIDs)
		if permErr != nil {
			slog.Error("batch resolving search permissions", "err", permErr, "server", srvID)
			continue
		}
		for _, chID := range chIDs {
			if chPerms, ok := permsMap[chID]; ok && permissions.Has(chPerms, permissions.ViewChannel) {
				accessibleChannels[chID] = struct{}{}
			}
		}
	}

	// Filter hits to only accessible channels.
	filteredHits := make([]search.SearchResult, 0, len(hits))
	for _, hit := range hits {
		if _, ok := accessibleChannels[hit.Doc.ChannelID]; ok {
			filteredHits = append(filteredHits, hit)
		}
	}
	hits = filteredHits

	// Group hits by channel for batch fetching from ScyllaDB.
	hitsByChannel := make(map[string][]search.SearchResult)
	for _, hit := range hits {
		hitsByChannel[hit.Doc.ChannelID] = append(hitsByChannel[hit.Doc.ChannelID], hit)
	}

	allMsgs := make(map[string]*models.Message)
	for chID, chHits := range hitsByChannel {
		ids := make([]string, len(chHits))
		for i, h := range chHits {
			ids[i] = h.Doc.ID
		}
		msgs, batchErr := s.messageStore.GetMessagesByIDs(ctx, chID, ids)
		if batchErr != nil {
			slog.Error("batch fetch messages", "err", batchErr, "channel", chID)
			continue
		}
		for id, msg := range msgs {
			allMsgs[id] = msg
		}
	}

	// First pass: collect all attachment IDs across all messages.
	var allAttachmentIDs []string
	for _, hit := range hits {
		msg, ok := allMsgs[hit.Doc.ID]
		if !ok || msg.Deleted {
			continue
		}
		allAttachmentIDs = append(allAttachmentIDs, msg.AttachmentIDs...)
	}

	// Single bulk fetch for all attachments.
	var allAttachments map[string]*models.Attachment
	if len(allAttachmentIDs) > 0 {
		attMap, attErr := s.mediaStore.GetAttachmentsByIDs(ctx, allAttachmentIDs)
		if attErr != nil {
			slog.Error("bulk fetch attachments for search", "err", attErr)
		} else {
			allAttachments = attMap
		}
	}

	// Second pass: build results in original hit order with attachments distributed.
	results := make([]*v1.SearchResult, 0, len(hits))
	for _, hit := range hits {
		msg, ok := allMsgs[hit.Doc.ID]
		if !ok || msg.Deleted {
			continue
		}

		var protoAttachments []*v1.Attachment
		if len(msg.AttachmentIDs) > 0 && allAttachments != nil {
			protoAttachments = toProtoAttachments(msg.AttachmentIDs, allAttachments)
		}

		results = append(results, &v1.SearchResult{
			Message: messageToProto(msg, protoAttachments),
		})
	}

	return connect.NewResponse(&v1.SearchMessagesResponse{
		Results:   results,
		TotalHits: int32(totalHits),
	}), nil
}

func (s *chatService) ListServers(ctx context.Context, _ *connect.Request[v1.ListServersRequest]) (*connect.Response[v1.ListServersResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing user"))
	}

	servers, err := s.chatStore.ListServers(ctx, userID)
	if err != nil {
		slog.Error("listing servers", "err", err, "user", userID)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	protoServers := make([]*v1.Server, len(servers))
	for i, srv := range servers {
		protoServers[i] = serverToProto(srv)
	}

	return connect.NewResponse(&v1.ListServersResponse{
		Servers: protoServers,
	}), nil
}

func (s *chatService) ListChannels(ctx context.Context, req *connect.Request[v1.ListChannelsRequest]) (*connect.Response[v1.ListChannelsResponse], error) {
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

	channels, err := s.chatStore.ListChannels(ctx, req.Msg.ServerId, userID)
	if err != nil {
		slog.Error("listing channels", "err", err, "user", userID, "server", req.Msg.ServerId)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	// Batch-resolve ViewChannel permission for all channels.
	channelIDs := make([]string, len(channels))
	for i, ch := range channels {
		channelIDs[i] = ch.ID
	}
	permsMap, permErr := s.resolvePermissionsBatch(ctx, userID, req.Msg.ServerId, channelIDs)
	if permErr != nil {
		slog.Error("batch resolving channel permissions", "err", permErr, "server", req.Msg.ServerId)
		return nil, permErr
	}

	var protoChannels []*v1.Channel
	for _, ch := range channels {
		if chPerms, ok := permsMap[ch.ID]; ok && permissions.Has(chPerms, permissions.ViewChannel) {
			protoChannels = append(protoChannels, channelToProto(ch))
		}
	}

	return connect.NewResponse(&v1.ListChannelsResponse{
		Channels: protoChannels,
	}), nil
}

func (s *chatService) EditMessage(ctx context.Context, req *connect.Request[v1.EditMessageRequest]) (*connect.Response[v1.EditMessageResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing user"))
	}
	if req.Msg.ChannelId == "" || req.Msg.MessageId == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("channel_id and message_id are required"))
	}
	if len(req.Msg.EncryptedContent) == 0 {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("encrypted_content is required"))
	}
	if len(req.Msg.EncryptedContent) > 16000 {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("message content too large"))
	}

	ch, isMember, err := s.chatStore.GetChannelAndCheckMembership(ctx, req.Msg.ChannelId, userID)
	if err != nil {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("channel not found"))
	}
	if !isMember {
		return nil, connect.NewError(connect.CodePermissionDenied, errors.New("not a member of this server"))
	}

	// DM block guard: prevent blocked users from editing messages.
	if s.isDMChannel(ch) {
		otherID, err := s.chatStore.GetDMOtherParticipantID(ctx, ch.ID, userID)
		if err != nil {
			slog.Error("getting DM other participant for edit", "err", err, "channel", ch.ID)
			return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
		}
		blocked, err := s.blockStore.IsBlockedEither(ctx, userID, otherID)
		if err != nil {
			slog.Error("checking block in EditMessage", "err", err, "user", userID, "other", otherID)
			return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
		}
		if blocked {
			return nil, errUnableToMessage
		}
	}

	if err := s.requireChannelAccess(ctx, ch, userID); err != nil {
		return nil, err
	}

	msg, err := s.messageStore.GetMessage(ctx, req.Msg.ChannelId, req.Msg.MessageId)
	if err != nil {
		slog.Error("getting message", "err", err, "user", userID, "channel", req.Msg.ChannelId)
		return nil, connect.NewError(connect.CodeNotFound, errors.New("message not found"))
	}
	if msg.Deleted {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("message not found"))
	}
	if msg.AuthorID != userID {
		return nil, connect.NewError(connect.CodePermissionDenied, errors.New("not the message author"))
	}

	// Timed-out users lose SendMessages, so they cannot edit either.
	if ch.ServerID != "" {
		perms, permErr := s.resolvePermissions(ctx, userID, ch.ServerID, ch.ID)
		if permErr != nil {
			return nil, permErr
		}
		if !permissions.Has(perms, permissions.SendMessages) {
			return nil, connect.NewError(connect.CodePermissionDenied, errors.New("missing SendMessages permission"))
		}
	}

	// Defense-in-depth: reject plaintext (keyVersion=0) on encrypted channels.
	if req.Msg.GetKeyVersion() == 0 && s.encryptionChecker != nil {
		encrypted, encErr := s.encryptionChecker.HasChannelKeyVersion(ctx, req.Msg.ChannelId)
		if encErr != nil {
			slog.Error("checking channel encryption status", "err", encErr, "channel", req.Msg.ChannelId)
			return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
		}
		if encrypted {
			return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("encrypted channel requires keyVersion > 0"))
		}
	}

	// Validate and sanitize mention fields for edit (same rules as SendMessage).
	editMentionedUserIDs := req.Msg.MentionedUserIds
	editMentionedRoleIDs := req.Msg.MentionedRoleIds
	editMentionEveryone := req.Msg.MentionEveryone

	if ch.ServerID == "" {
		editMentionEveryone = false
		editMentionedRoleIDs = nil
	}
	if len(editMentionedUserIDs) > 100 {
		return nil, connect.NewError(connect.CodeInvalidArgument,
			errors.New("max 100 mentions per message"))
	}
	editSeen := make(map[string]struct{}, len(editMentionedUserIDs))
	editFiltered := make([]string, 0, len(editMentionedUserIDs))
	for _, uid := range editMentionedUserIDs {
		if !validULID.MatchString(uid) {
			return nil, connect.NewError(connect.CodeInvalidArgument,
				fmt.Errorf("invalid mention user ID: %s", uid))
		}
		if uid == userID {
			continue
		}
		if _, ok := editSeen[uid]; !ok {
			editSeen[uid] = struct{}{}
			editFiltered = append(editFiltered, uid)
		}
	}
	editMentionedUserIDs = editFiltered

	// Validate and deduplicate mentioned_role_ids for edit.
	if len(editMentionedRoleIDs) > 50 {
		return nil, connect.NewError(connect.CodeInvalidArgument,
			errors.New("max 50 role mentions per message"))
	}
	editRoleSeen := make(map[string]struct{}, len(editMentionedRoleIDs))
	editRoleFiltered := make([]string, 0, len(editMentionedRoleIDs))
	for _, rid := range editMentionedRoleIDs {
		if !validULID.MatchString(rid) {
			return nil, connect.NewError(connect.CodeInvalidArgument,
				fmt.Errorf("invalid mention role ID: %s", rid))
		}
		if _, ok := editRoleSeen[rid]; !ok {
			editRoleSeen[rid] = struct{}{}
			editRoleFiltered = append(editRoleFiltered, rid)
		}
	}
	editMentionedRoleIDs = editRoleFiltered

	if editMentionEveryone && ch.ServerID != "" {
		if !s.hasPermission(ctx, userID, ch.ServerID, permissions.MentionEveryone) {
			editMentionEveryone = false
		}
	}

	now := time.Now()
	if err := s.messageStore.EditMessage(ctx, req.Msg.ChannelId, req.Msg.MessageId, req.Msg.EncryptedContent, editMentionedUserIDs, editMentionedRoleIDs, editMentionEveryone, now, req.Msg.GetKeyVersion()); err != nil {
		slog.Error("editing message", "err", err, "user", userID, "channel", req.Msg.ChannelId)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	// Hydrate attachments for the edit event so the frontend doesn't erase them.
	var editAttachments []*v1.Attachment
	if len(msg.AttachmentIDs) > 0 {
		attachments, aErr := s.mediaStore.GetAttachmentsByIDs(ctx, msg.AttachmentIDs)
		if aErr != nil {
			slog.Error("hydrating attachments for edit event", "err", aErr, "message", msg.MessageID)
		} else {
			editAttachments = toProtoAttachments(msg.AttachmentIDs, attachments)
		}
	}

	// Publish update event with the full message proto.
	// Build a transient model with updated content and editedAt for messageToProto.
	editedMsg := *msg
	editedMsg.EncryptedContent = req.Msg.EncryptedContent
	editedMsg.MentionedUserIDs = editMentionedUserIDs
	editedMsg.MentionedRoleIDs = editMentionedRoleIDs
	editedMsg.MentionEveryone = editMentionEveryone
	editedMsg.EditedAt = now
	editedMsg.KeyVersion = req.Msg.GetKeyVersion()
	event := &v1.Event{
		Id:        models.NewID(),
		Type:      v1.EventType_EVENT_TYPE_MESSAGE_UPDATE,
		Timestamp: timestamppb.New(now),
		Payload:   &v1.Event_MessageUpdate{MessageUpdate: messageToProto(&editedMsg, editAttachments)},
	}
	eventData, err := proto.Marshal(event)
	if err != nil {
		slog.Error("marshaling event", "err", err)
		// Don't return error - the DB mutation succeeded, event broadcast is best-effort
	} else {
		if err := s.nc.Publish(subjects.DeliverChannel(req.Msg.ChannelId), eventData); err != nil {
			slog.Warn("nats publish failed", "subject", subjects.DeliverChannel(req.Msg.ChannelId), "err", err)
		}
	}

	// E2EE guard: encrypted content is ciphertext — never parse, index, or
	// Universal E2EE: all content is ciphertext. Server-side search indexing
	// and link preview extraction are removed.

	return connect.NewResponse(&v1.EditMessageResponse{
		EditedAt: timestamppb.New(now),
	}), nil
}

func (s *chatService) DeleteMessage(ctx context.Context, req *connect.Request[v1.DeleteMessageRequest]) (*connect.Response[v1.DeleteMessageResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing user"))
	}
	if req.Msg.ChannelId == "" || req.Msg.MessageId == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("channel_id and message_id are required"))
	}

	ch, isMember, err := s.chatStore.GetChannelAndCheckMembership(ctx, req.Msg.ChannelId, userID)
	if err != nil {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("channel not found"))
	}
	if !isMember {
		return nil, connect.NewError(connect.CodePermissionDenied, errors.New("not a member of this server"))
	}
	if err := s.requireChannelAccess(ctx, ch, userID); err != nil {
		return nil, err
	}

	msg, err := s.messageStore.GetMessage(ctx, req.Msg.ChannelId, req.Msg.MessageId)
	if err != nil {
		slog.Error("getting message", "err", err, "user", userID, "channel", req.Msg.ChannelId)
		return nil, connect.NewError(connect.CodeNotFound, errors.New("message not found"))
	}
	if msg.Deleted {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("message not found"))
	}
	if msg.AuthorID != userID {
		// Allow users with MANAGE_MESSAGES permission to delete others' messages.
		// Use resolvePermissions for channel-scoped override awareness.
		if ch.ServerID != "" {
			perms, permErr := s.resolvePermissions(ctx, userID, ch.ServerID, ch.ID)
			if permErr != nil {
				return nil, permErr
			}
			if !permissions.Has(perms, permissions.ManageMessages) {
				return nil, connect.NewError(connect.CodePermissionDenied, errors.New("not the message author"))
			}
		} else {
			return nil, connect.NewError(connect.CodePermissionDenied, errors.New("not the message author"))
		}
	}

	if err := s.messageStore.DeleteMessage(ctx, req.Msg.ChannelId, req.Msg.MessageId); err != nil {
		slog.Error("deleting message", "err", err, "user", userID, "channel", req.Msg.ChannelId)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	event := &v1.Event{
		Id:        models.NewID(),
		Type:      v1.EventType_EVENT_TYPE_MESSAGE_DELETE,
		Timestamp: timestamppb.New(time.Now()),
		Payload: &v1.Event_MessageDelete{MessageDelete: &v1.MessageDeleteEvent{
			ChannelId: req.Msg.ChannelId,
			MessageId: req.Msg.MessageId,
		}},
	}
	eventData, err := proto.Marshal(event)
	if err != nil {
		slog.Error("marshaling event", "err", err)
		// Don't return error - the DB mutation succeeded, event broadcast is best-effort
	} else {
		if err := s.nc.Publish(subjects.DeliverChannel(req.Msg.ChannelId), eventData); err != nil {
			slog.Warn("nats publish failed", "subject", subjects.DeliverChannel(req.Msg.ChannelId), "err", err)
		}
	}

	// Clean up reactions for the deleted message (best-effort).
	if s.reactionStore != nil {
		if rxErr := s.reactionStore.RemoveAllMessageReactions(ctx, req.Msg.ChannelId, req.Msg.MessageId); rxErr != nil {
			slog.Error("removing reactions for deleted message", "err", rxErr, "channel", req.Msg.ChannelId)
		}
	}

	// Clean up link embeds for the deleted message (best-effort).
	if s.linkPreviewStore != nil {
		if err := s.linkPreviewStore.DeleteMessageEmbeds(ctx, req.Msg.ChannelId, req.Msg.MessageId); err != nil {
			slog.Error("removing embeds for deleted message", "err", err, "channel", req.Msg.ChannelId)
		}
	}

	// Clean up reply index if the deleted message was a reply (best-effort).
	if msg.ReplyToID != "" {
		if err := s.messageStore.DeleteReplyIndex(ctx, req.Msg.ChannelId, msg.ReplyToID, req.Msg.MessageId); err != nil {
			slog.Error("removing reply index for deleted message", "err", err, "channel", req.Msg.ChannelId)
		}
	}

	// Clean up pin if the deleted message was pinned.
	pinned, pinErr := s.pinStore.IsPinned(ctx, req.Msg.ChannelId, req.Msg.MessageId)
	if pinErr != nil {
		slog.Error("checking pin for delete", "err", pinErr, "channel", req.Msg.ChannelId)
		// Don't fail the delete — pin cleanup is best-effort
	} else if pinned {
		if unpinErr := s.pinStore.UnpinMessage(ctx, req.Msg.ChannelId, req.Msg.MessageId); unpinErr != nil {
			slog.Error("removing pin for deleted message", "err", unpinErr, "channel", req.Msg.ChannelId)
		} else {
			// Publish PIN_REMOVE event so clients update their pin lists.
			pinEvent := &v1.Event{
				Id:        models.NewID(),
				Type:      v1.EventType_EVENT_TYPE_PIN_REMOVE,
				Timestamp: timestamppb.New(time.Now()),
				Payload: &v1.Event_PinRemove{PinRemove: &v1.PinRemoveEvent{
					ChannelId: req.Msg.ChannelId,
					MessageId: req.Msg.MessageId,
				}},
			}
			pinEventData, marshalErr := proto.Marshal(pinEvent)
			if marshalErr != nil {
				slog.Error("marshaling pin remove event", "err", marshalErr)
			} else {
				s.nc.Publish(subjects.DeliverChannel(req.Msg.ChannelId), pinEventData)
			}
		}
	}

	return connect.NewResponse(&v1.DeleteMessageResponse{}), nil
}
func (s *chatService) UpdateChannel(ctx context.Context, req *connect.Request[v1.UpdateChannelRequest]) (*connect.Response[v1.UpdateChannelResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing user"))
	}
	if req.Msg.ChannelId == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("channel_id is required"))
	}

	ch, err := s.chatStore.GetChannel(ctx, req.Msg.ChannelId)
	if err != nil {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("channel not found"))
	}
	if s.isServerlessChannel(ch) {
		return nil, connect.NewError(connect.CodeFailedPrecondition, errors.New("cannot update DM channels"))
	}

	// Require ManageChannels permission.
	_, _, _, permErr := s.requirePermission(ctx, userID, ch.ServerID, permissions.ManageChannels)
	if permErr != nil {
		return nil, permErr
	}

	var name, topic *string
	var position *int
	var isPrivate *bool
	var slowModeSeconds *int
	var isDefault *bool
	var channelGroupID *string
	if req.Msg.Name != nil {
		name = req.Msg.Name
	}
	if req.Msg.Topic != nil {
		topic = req.Msg.Topic
	}
	if req.Msg.Position != nil {
		p := int(*req.Msg.Position)
		position = &p
	}
	if req.Msg.SlowModeSeconds != nil {
		sm := int(*req.Msg.SlowModeSeconds)
		slowModeSeconds = &sm
	}
	if req.Msg.IsDefault != nil {
		// Private channels cannot be set as default.
		if ch.IsPrivate && *req.Msg.IsDefault {
			return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("private channels cannot be marked as default"))
		}
		isDefault = req.Msg.IsDefault
	}
	if req.Msg.ChannelGroupId != nil {
		// Validate channel group belongs to the same server (empty string unsets the group).
		if *req.Msg.ChannelGroupId != "" {
			group, err := s.channelGroupStore.GetChannelGroup(ctx, *req.Msg.ChannelGroupId)
			if err != nil {
				return nil, connect.NewError(connect.CodeNotFound, errors.New("channel group not found"))
			}
			if group.ServerID != ch.ServerID {
				return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("channel group does not belong to this server"))
			}
		}
		channelGroupID = req.Msg.ChannelGroupId
	}
	if req.Msg.IsPrivate != nil {
		isPrivate = req.Msg.IsPrivate
	}

	// When privacy is being toggled, use the atomic method that wraps the
	// channel update and the ViewChannel override change in a single
	// transaction. Otherwise use the regular UpdateChannel.
	var updated *models.Channel
	privacyToggled := isPrivate != nil && *isPrivate != ch.IsPrivate
	if privacyToggled {
		everyoneRoleID := ch.ServerID // @everyone role ID = server ID
		updated, err = s.chatStore.UpdateChannelPrivacy(ctx, req.Msg.ChannelId, name, topic, position, isPrivate, slowModeSeconds, isDefault, channelGroupID, ch.IsPrivate, everyoneRoleID, permissions.ViewChannel)
	} else {
		updated, err = s.chatStore.UpdateChannel(ctx, req.Msg.ChannelId, name, topic, position, isPrivate, slowModeSeconds, isDefault, channelGroupID)
	}
	if err != nil {
		slog.Error("updating channel", "err", err, "user", userID, "channel", req.Msg.ChannelId)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	// Broadcast channel update event.
	now := time.Now()
	event := &v1.Event{
		Id:        models.NewID(),
		Type:      v1.EventType_EVENT_TYPE_CHANNEL_UPDATE,
		Timestamp: timestamppb.New(now),
		Payload: &v1.Event_ChannelUpdate{
			ChannelUpdate: channelToProto(updated),
		},
	}
	eventData, err := proto.Marshal(event)
	if err != nil {
		slog.Error("marshaling event", "err", err)
		// Don't return error - the DB mutation succeeded, event broadcast is best-effort
	} else {
		// Encode privacy prefix to avoid full deserialization in gateway (TODO 270).
		privateChID := ""
		if updated.IsPrivate {
			privateChID = updated.ID
		}
		s.nc.Publish(subjects.ServerChannel(updated.ServerID), subjects.EncodeServerChannelEvent(eventData, privateChID))
	}

	return connect.NewResponse(&v1.UpdateChannelResponse{
		Channel: channelToProto(updated),
	}), nil
}

func (s *chatService) DeleteChannel(ctx context.Context, req *connect.Request[v1.DeleteChannelRequest]) (*connect.Response[v1.DeleteChannelResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing user"))
	}
	if req.Msg.ChannelId == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("channel_id is required"))
	}

	ch, err := s.chatStore.GetChannel(ctx, req.Msg.ChannelId)
	if err != nil {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("channel not found"))
	}
	if s.isServerlessChannel(ch) {
		return nil, connect.NewError(connect.CodeFailedPrecondition, errors.New("cannot delete DM channels"))
	}

	// Require ManageChannels permission.
	_, _, _, permErr := s.requirePermission(ctx, userID, ch.ServerID, permissions.ManageChannels)
	if permErr != nil {
		return nil, permErr
	}

	if err := s.chatStore.DeleteChannel(ctx, req.Msg.ChannelId); err != nil {
		slog.Error("deleting channel", "err", err, "user", userID, "channel", req.Msg.ChannelId)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	// Broadcast channel delete event.
	now := time.Now()
	event := &v1.Event{
		Id:        models.NewID(),
		Type:      v1.EventType_EVENT_TYPE_CHANNEL_DELETE,
		Timestamp: timestamppb.New(now),
		Payload: &v1.Event_ChannelDelete{
			ChannelDelete: &v1.ChannelDeleteEvent{
				ChannelId: req.Msg.ChannelId,
				ServerId:  ch.ServerID,
			},
		},
	}
	eventData, err := proto.Marshal(event)
	if err != nil {
		slog.Error("marshaling event", "err", err)
		// Don't return error - the DB mutation succeeded, event broadcast is best-effort
	} else {
		// Delete events always broadcast to all server members (TODO 270).
		s.nc.Publish(subjects.ServerChannel(ch.ServerID), subjects.EncodeServerChannelEvent(eventData, ""))
	}

	return connect.NewResponse(&v1.DeleteChannelResponse{}), nil
}
func (s *chatService) GetChannel(context.Context, *connect.Request[v1.GetChannelRequest]) (*connect.Response[v1.GetChannelResponse], error) {
	return nil, connect.NewError(connect.CodeUnimplemented, errors.New("not implemented"))
}
func (s *chatService) GetServer(ctx context.Context, req *connect.Request[v1.GetServerRequest]) (*connect.Response[v1.GetServerResponse], error) {
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

	srv, err := s.chatStore.GetServer(ctx, req.Msg.ServerId)
	if err != nil {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("server not found"))
	}

	return connect.NewResponse(&v1.GetServerResponse{
		Server: serverToProto(srv),
	}), nil
}

func (s *chatService) UpdateServer(ctx context.Context, req *connect.Request[v1.UpdateServerRequest]) (*connect.Response[v1.UpdateServerResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing user"))
	}
	if req.Msg.ServerId == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("server_id is required"))
	}

	// Require ManageServer permission (more granular than Administrator).
	_, _, _, permErr := s.requirePermission(ctx, userID, req.Msg.ServerId, permissions.ManageServer)
	if permErr != nil {
		return nil, permErr
	}

	// Validate onboarding fields.
	if req.Msg.WelcomeMessage != nil && len(*req.Msg.WelcomeMessage) > 5000 {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("welcome_message exceeds 5000 characters"))
	}
	if req.Msg.Rules != nil {
		lines := strings.Split(*req.Msg.Rules, "\n")
		if len(lines) > 25 {
			return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("rules exceed 25 lines"))
		}
	}
	// rules_required can only be true if onboarding_enabled is true.
	if req.Msg.RulesRequired != nil && *req.Msg.RulesRequired {
		if req.Msg.OnboardingEnabled != nil && !*req.Msg.OnboardingEnabled {
			return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("rules_required requires onboarding_enabled"))
		}
		// If not explicitly setting onboarding_enabled, check current state.
		if req.Msg.OnboardingEnabled == nil {
			srv, err := s.chatStore.GetServer(ctx, req.Msg.ServerId)
			if err != nil {
				return nil, connect.NewError(connect.CodeNotFound, errors.New("server not found"))
			}
			if !srv.OnboardingEnabled {
				return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("rules_required requires onboarding_enabled"))
			}
		}
	}

	updated, err := s.chatStore.UpdateServer(ctx, req.Msg.ServerId,
		req.Msg.Name, req.Msg.IconUrl,
		req.Msg.WelcomeMessage, req.Msg.Rules,
		req.Msg.OnboardingEnabled, req.Msg.RulesRequired,
		req.Msg.DefaultChannelPrivacy,
	)
	if err != nil {
		slog.Error("updating server", "err", err, "user", userID, "server", req.Msg.ServerId)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	return connect.NewResponse(&v1.UpdateServerResponse{
		Server: serverToProto(updated),
	}), nil
}

func (s *chatService) DeleteServer(context.Context, *connect.Request[v1.DeleteServerRequest]) (*connect.Response[v1.DeleteServerResponse], error) {
	return nil, connect.NewError(connect.CodeUnimplemented, errors.New("not implemented"))
}

func (s *chatService) AcknowledgeRules(ctx context.Context, req *connect.Request[v1.AcknowledgeRulesRequest]) (*connect.Response[v1.AcknowledgeRulesResponse], error) {
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

	// Verify rules are configured.
	srv, err := s.chatStore.GetServer(ctx, req.Msg.ServerId)
	if err != nil {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("server not found"))
	}
	if !srv.RulesRequired {
		return nil, connect.NewError(connect.CodeFailedPrecondition, errors.New("rules are not required for this server"))
	}

	acknowledgedAt, err := s.chatStore.AcknowledgeRules(ctx, userID, req.Msg.ServerId)
	if err != nil {
		slog.Error("acknowledging rules", "err", err, "user", userID, "server", req.Msg.ServerId)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	return connect.NewResponse(&v1.AcknowledgeRulesResponse{
		AcknowledgedAt: timestamppb.New(acknowledgedAt),
	}), nil
}

func (s *chatService) CompleteOnboarding(ctx context.Context, req *connect.Request[v1.CompleteOnboardingRequest]) (*connect.Response[v1.CompleteOnboardingResponse], error) {
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

	// Verify onboarding is enabled.
	srv, err := s.chatStore.GetServer(ctx, req.Msg.ServerId)
	if err != nil {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("server not found"))
	}
	if !srv.OnboardingEnabled {
		return nil, connect.NewError(connect.CodeFailedPrecondition, errors.New("onboarding is not enabled for this server"))
	}

	// Enforce rules acknowledgement prerequisite when required.
	if srv.RulesRequired {
		acknowledged, err := s.chatStore.CheckRulesAcknowledged(ctx, userID, srv.ID)
		if err != nil {
			slog.Error("checking rules acknowledgement", "err", err, "user", userID, "server", srv.ID)
			return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
		}
		if !acknowledged {
			return nil, connect.NewError(connect.CodeFailedPrecondition,
				errors.New("you must acknowledge server rules before completing onboarding"))
		}
	}

	completedAt, skippedChannelIDs, skippedRoleIDs, err := s.chatStore.CompleteOnboarding(
		ctx, userID, req.Msg.ServerId, req.Msg.ChannelIds, req.Msg.RoleIds,
	)
	if err != nil {
		slog.Error("completing onboarding", "err", err, "user", userID, "server", req.Msg.ServerId)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	// Signal gateway to refresh channel subscriptions for this user.
	s.nc.Publish(subjects.UserSubscription(userID), nil)

	return connect.NewResponse(&v1.CompleteOnboardingResponse{
		CompletedAt:       timestamppb.New(completedAt),
		SkippedChannelIds: skippedChannelIDs,
		SkippedRoleIds:    skippedRoleIDs,
	}), nil
}
func (s *chatService) JoinServer(ctx context.Context, req *connect.Request[v1.JoinServerRequest]) (*connect.Response[v1.JoinServerResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing user"))
	}
	if req.Msg.InviteCode == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("invite_code is required"))
	}
	code := strings.ToLower(strings.TrimSpace(req.Msg.InviteCode))

	// Peek at invite to get server ID without consuming a use.
	inv, err := s.inviteStore.GetInvite(ctx, code)
	if err != nil {
		slog.Error("join: get invite failed", "err", err, "code", code)
		return nil, connect.NewError(connect.CodeNotFound, errors.New("invalid invite"))
	}

	// Check if user is banned from this server.
	banned, err := s.banStore.IsBanned(ctx, inv.ServerID, userID)
	if err != nil {
		slog.Error("checking ban", "err", err, "user", userID, "server", inv.ServerID)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}
	if banned {
		return nil, connect.NewError(connect.CodePermissionDenied, errors.New("you are banned from this server"))
	}

	// Check membership before consuming to avoid wasting invite uses.
	isMember, err := s.chatStore.IsMember(ctx, userID, inv.ServerID)
	if err != nil {
		slog.Error("join: check membership failed", "err", err, "user", userID, "server", inv.ServerID)
		return nil, connect.NewError(connect.CodeInternal, errors.New("check membership failed"))
	}
	if isMember {
		return nil, connect.NewError(connect.CodeAlreadyExists, errors.New("already a member"))
	}

	// Now atomically consume the invite.
	consumed, err := s.inviteStore.ConsumeInvite(ctx, code)
	if err != nil {
		slog.Error("join: consume invite failed", "err", err, "user", userID)
		return nil, connect.NewError(connect.CodeInternal, errors.New("consume invite failed"))
	}
	if consumed == nil {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("invalid invite"))
	}

	if err := s.chatStore.AddMember(ctx, userID, consumed.ServerID); err != nil {
		slog.Error("join: add member failed", "err", err, "user", userID, "server", consumed.ServerID)
		return nil, connect.NewError(connect.CodeInternal, errors.New("add member failed"))
	}

	srv, err := s.chatStore.GetServer(ctx, consumed.ServerID)
	if err != nil {
		slog.Error("join: get server failed", "err", err, "server", consumed.ServerID)
		return nil, connect.NewError(connect.CodeInternal, errors.New("get server failed"))
	}

	now := time.Now()
	event := &v1.Event{
		Id:        models.NewID(),
		Type:      v1.EventType_EVENT_TYPE_MEMBER_JOIN,
		Timestamp: timestamppb.New(now),
		Payload: &v1.Event_MemberJoin{
			MemberJoin: &v1.Member{
				UserId:         userID,
				ServerId:       consumed.ServerID,
				JoinedAt:       timestamppb.New(now),
				InviterUserId:  inv.CreatorID,
			},
		},
	}
	eventData, err := proto.Marshal(event)
	if err != nil {
		slog.Error("marshaling event", "err", err)
		// Don't return error - the DB mutation succeeded, event broadcast is best-effort
	} else {
		if err := s.nc.Publish(subjects.ServerMember(consumed.ServerID), eventData); err != nil {
			slog.Warn("nats publish failed", "subject", subjects.ServerMember(consumed.ServerID), "err", err)
		}
	}

	// Signal gateway to refresh channel subscriptions for this user.
	s.nc.Publish(subjects.UserSubscription(userID), nil)

	return connect.NewResponse(&v1.JoinServerResponse{
		Server: serverToProto(srv),
	}), nil
}

func (s *chatService) LeaveServer(ctx context.Context, req *connect.Request[v1.LeaveServerRequest]) (*connect.Response[v1.LeaveServerResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing user"))
	}
	if req.Msg.ServerId == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("server_id is required"))
	}

	srv, err := s.chatStore.GetServer(ctx, req.Msg.ServerId)
	if err != nil {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("server not found"))
	}

	if srv.OwnerID == userID {
		return nil, connect.NewError(connect.CodeFailedPrecondition, errors.New("server owner cannot leave"))
	}

	isMember, err := s.chatStore.IsMember(ctx, userID, req.Msg.ServerId)
	if err != nil {
		slog.Error("checking membership", "err", err, "user", userID, "server", req.Msg.ServerId)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}
	if !isMember {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("not a member"))
	}

	if err := s.chatStore.RemoveMember(ctx, userID, req.Msg.ServerId); err != nil {
		slog.Error("removing member", "err", err, "user", userID, "server", req.Msg.ServerId)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	// Clean up channel_members and channel_key_envelopes for the leaving user.
	if err := s.chatStore.RemoveChannelMembersForServer(ctx, userID, req.Msg.ServerId); err != nil {
		slog.Error("removing channel members for leaving user", "err", err, "user", userID, "server", req.Msg.ServerId)
	}

	event := &v1.Event{
		Id:        models.NewID(),
		Type:      v1.EventType_EVENT_TYPE_MEMBER_REMOVE,
		Timestamp: timestamppb.New(time.Now()),
		Payload: &v1.Event_MemberRemove{
			MemberRemove: &v1.MemberRemoveEvent{
				ServerId: req.Msg.ServerId,
				UserId:   userID,
			},
		},
	}
	eventData, err := proto.Marshal(event)
	if err != nil {
		slog.Error("marshaling event", "err", err)
		// Don't return error - the DB mutation succeeded, event broadcast is best-effort
	} else {
		if err := s.nc.Publish(subjects.ServerMember(req.Msg.ServerId), eventData); err != nil {
			slog.Warn("nats publish failed", "subject", subjects.ServerMember(req.Msg.ServerId), "err", err)
		}
	}

	// Signal gateway to refresh channel subscriptions for this user.
	s.nc.Publish(subjects.UserSubscription(userID), nil)

	return connect.NewResponse(&v1.LeaveServerResponse{}), nil
}
func (s *chatService) CreateInvite(ctx context.Context, req *connect.Request[v1.CreateInviteRequest]) (*connect.Response[v1.CreateInviteResponse], error) {
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

	// Require CreateInvite permission.
	if _, _, _, permErr := s.requirePermission(ctx, userID, req.Msg.ServerId, permissions.CreateInvite); permErr != nil {
		return nil, permErr
	}

	if req.Msg.MaxUses < 0 {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("max_uses must be non-negative"))
	}

	var expiresAt *time.Time
	if req.Msg.MaxAgeSeconds > 0 {
		t := time.Now().Add(time.Duration(req.Msg.MaxAgeSeconds) * time.Second)
		expiresAt = &t
	}

	inv, err := s.inviteStore.CreateInvite(ctx, req.Msg.ServerId, userID, int(req.Msg.MaxUses), expiresAt)
	if err != nil {
		slog.Error("creating invite", "err", err, "user", userID, "server", req.Msg.ServerId)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	return connect.NewResponse(&v1.CreateInviteResponse{
		Invite: inviteToProto(inv),
	}), nil
}

func (s *chatService) ResolveInvite(ctx context.Context, req *connect.Request[v1.ResolveInviteRequest]) (*connect.Response[v1.ResolveInviteResponse], error) {
	if req.Msg.Code == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("code is required"))
	}
	code := strings.ToLower(strings.TrimSpace(req.Msg.Code))

	inv, err := s.inviteStore.GetInvite(ctx, code)
	if err != nil {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("invalid invite"))
	}

	// Check validity.
	if inv.Revoked {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("invalid invite"))
	}
	if inv.ExpiresAt != nil && inv.ExpiresAt.Before(time.Now()) {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("invalid invite"))
	}
	if inv.MaxUses > 0 && inv.UseCount >= inv.MaxUses {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("invalid invite"))
	}

	srv, err := s.chatStore.GetServer(ctx, inv.ServerID)
	if err != nil {
		slog.Error("getting server for invite", "err", err, "server", inv.ServerID)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	memberCount, err := s.chatStore.GetMemberCount(ctx, inv.ServerID)
	if err != nil {
		slog.Error("getting member count", "err", err, "server", inv.ServerID)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	// Only return non-sensitive invite fields (code + server_id).
	// Omit creator_id, use_count, max_uses, expires_at, created_at to avoid
	// leaking metadata to unauthenticated or non-member callers.
	return connect.NewResponse(&v1.ResolveInviteResponse{
		Server:      serverToProto(srv),
		MemberCount: int32(memberCount),
		Invite: &v1.Invite{
			Code:     inv.Code,
			ServerId: inv.ServerID,
		},
	}), nil
}

func (s *chatService) RevokeInvite(ctx context.Context, req *connect.Request[v1.RevokeInviteRequest]) (*connect.Response[v1.RevokeInviteResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing user"))
	}
	if req.Msg.Code == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("code is required"))
	}
	code := strings.ToLower(strings.TrimSpace(req.Msg.Code))

	inv, err := s.inviteStore.GetInvite(ctx, code)
	if err != nil {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("invite not found"))
	}

	if err := s.requireMembership(ctx, userID, inv.ServerID); err != nil {
		return nil, err
	}

	// Must be the invite creator or the server owner.
	if inv.CreatorID != userID {
		srv, err := s.chatStore.GetServer(ctx, inv.ServerID)
		if err != nil {
			slog.Error("getting server", "err", err, "server", inv.ServerID)
			return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
		}
		if srv.OwnerID != userID {
			return nil, connect.NewError(connect.CodePermissionDenied, errors.New("only the invite creator or server owner can revoke"))
		}
	}

	if err := s.inviteStore.RevokeInvite(ctx, code); err != nil {
		slog.Error("revoking invite", "err", err, "user", userID)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	return connect.NewResponse(&v1.RevokeInviteResponse{}), nil
}

func (s *chatService) ListInvites(ctx context.Context, req *connect.Request[v1.ListInvitesRequest]) (*connect.Response[v1.ListInvitesResponse], error) {
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

	invites, err := s.inviteStore.ListInvites(ctx, req.Msg.ServerId)
	if err != nil {
		slog.Error("listing invites", "err", err, "server", req.Msg.ServerId)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	protoInvites := make([]*v1.Invite, len(invites))
	for i, inv := range invites {
		protoInvites[i] = inviteToProto(inv)
	}

	return connect.NewResponse(&v1.ListInvitesResponse{
		Invites: protoInvites,
	}), nil
}
func (s *chatService) GetReplies(ctx context.Context, req *connect.Request[v1.GetRepliesRequest]) (*connect.Response[v1.GetRepliesResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing user"))
	}
	if req.Msg.ChannelId == "" || req.Msg.MessageId == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("channel_id and message_id are required"))
	}

	ch, err := s.chatStore.GetChannel(ctx, req.Msg.ChannelId)
	if err != nil {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("channel not found"))
	}

	if err := s.requireMembership(ctx, userID, ch.ServerID); err != nil {
		return nil, err
	}

	if err := s.requireChannelAccess(ctx, ch, userID); err != nil {
		return nil, err
	}

	// Permission checks (server channels only; DMs skip).
	if ch.ServerID != "" {
		perms, permErr := s.resolvePermissions(ctx, userID, ch.ServerID, ch.ID)
		if permErr != nil {
			return nil, permErr
		}
		if !permissions.Has(perms, permissions.ViewChannel) {
			return nil, connect.NewError(connect.CodePermissionDenied, errors.New("missing ViewChannel permission"))
		}
		if !permissions.Has(perms, permissions.ReadMessageHistory) {
			return nil, connect.NewError(connect.CodePermissionDenied, errors.New("missing ReadMessageHistory permission"))
		}
	}

	limit := int(req.Msg.GetLimit())
	entries, totalCount, err := s.messageStore.GetReplies(ctx, req.Msg.ChannelId, req.Msg.MessageId, limit)
	if err != nil {
		slog.Error("getting replies", "err", err, "channel", req.Msg.ChannelId, "message", req.Msg.MessageId)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	protoEntries := make([]*v1.ReplyEntry, len(entries))
	for i, e := range entries {
		protoEntries[i] = &v1.ReplyEntry{
			MessageId: e.MessageID,
			AuthorId:  e.AuthorID,
			CreatedAt: timestamppb.New(e.CreatedAt),
		}
	}

	return connect.NewResponse(&v1.GetRepliesResponse{
		Replies:    protoEntries,
		TotalCount: int32(totalCount),
	}), nil
}

func (s *chatService) GetMessagesByIDs(ctx context.Context, req *connect.Request[v1.GetMessagesByIDsRequest]) (*connect.Response[v1.GetMessagesByIDsResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing user"))
	}
	if req.Msg.ChannelId == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("channel_id is required"))
	}
	if len(req.Msg.MessageIds) == 0 {
		return connect.NewResponse(&v1.GetMessagesByIDsResponse{}), nil
	}
	if len(req.Msg.MessageIds) > 50 {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("max 50 message IDs"))
	}

	ch, err := s.chatStore.GetChannel(ctx, req.Msg.ChannelId)
	if err != nil {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("channel not found"))
	}

	if err := s.requireMembership(ctx, userID, ch.ServerID); err != nil {
		return nil, err
	}

	if err := s.requireChannelAccess(ctx, ch, userID); err != nil {
		return nil, err
	}

	// Permission checks (server channels only; DMs skip).
	if ch.ServerID != "" {
		perms, permErr := s.resolvePermissions(ctx, userID, ch.ServerID, ch.ID)
		if permErr != nil {
			return nil, permErr
		}
		if !permissions.Has(perms, permissions.ViewChannel) {
			return nil, connect.NewError(connect.CodePermissionDenied, errors.New("missing ViewChannel permission"))
		}
		if !permissions.Has(perms, permissions.ReadMessageHistory) {
			return nil, connect.NewError(connect.CodePermissionDenied, errors.New("missing ReadMessageHistory permission"))
		}
	}

	msgMap, err := s.messageStore.GetMessagesByIDs(ctx, req.Msg.ChannelId, req.Msg.MessageIds)
	if err != nil {
		slog.Error("getting messages by IDs", "err", err, "channel", req.Msg.ChannelId)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	var protoMessages []*v1.Message
	var messageIDs []string
	for _, msg := range msgMap {
		if msg.Deleted {
			continue
		}
		protoMessages = append(protoMessages, messageToProto(msg, nil))
		messageIDs = append(messageIDs, msg.MessageID)
	}

	// Hydrate link embeds.
	if len(messageIDs) > 0 && s.linkPreviewStore != nil {
		embedMap, err := s.linkPreviewStore.GetEmbedsForMessages(ctx, req.Msg.ChannelId, messageIDs)
		if err != nil {
			slog.Error("hydrating embeds for messages by IDs", "err", err, "channel", req.Msg.ChannelId)
		} else {
			for i, pm := range protoMessages {
				if previews, ok := embedMap[pm.Id]; ok {
					protoMessages[i].Embeds = embed.LinkPreviewsToProto(previews)
				}
			}
		}
	}

	return connect.NewResponse(&v1.GetMessagesByIDsResponse{
		Messages: protoMessages,
	}), nil
}

func (s *chatService) GetEffectivePermissions(ctx context.Context, req *connect.Request[v1.GetEffectivePermissionsRequest]) (*connect.Response[v1.GetEffectivePermissionsResponse], error) {
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

	targetUserID := req.Msg.UserId
	if targetUserID == "" {
		targetUserID = userID
	}

	// Querying another user's permissions requires ManageRoles.
	if targetUserID != userID {
		callerPerms, err := s.resolvePermissions(ctx, userID, req.Msg.ServerId, "")
		if err != nil {
			return nil, err
		}
		if !permissions.Has(callerPerms, permissions.ManageRoles) {
			return nil, connect.NewError(connect.CodePermissionDenied, errors.New("ManageRoles required to query other users"))
		}
		// Verify target is also a member.
		if err := s.requireMembership(ctx, targetUserID, req.Msg.ServerId); err != nil {
			return nil, connect.NewError(connect.CodeNotFound, errors.New("user is not a member of this server"))
		}
	}

	// Validate channel belongs to the requested server (prevent cross-server data leakage).
	if req.Msg.ChannelId != "" {
		ch, chErr := s.chatStore.GetChannel(ctx, req.Msg.ChannelId)
		if chErr != nil {
			return nil, connect.NewError(connect.CodeNotFound, errors.New("channel not found"))
		}
		if ch.ServerID != req.Msg.ServerId {
			return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("channel does not belong to this server"))
		}
	}

	perms, err := s.resolvePermissions(ctx, targetUserID, req.Msg.ServerId, req.Msg.ChannelId)
	if err != nil {
		return nil, err
	}

	resp := &v1.GetEffectivePermissionsResponse{
		Permissions: perms,
	}

	// If source attribution requested, compute it.
	if req.Msg.IncludeSources {
		sources, srcErr := s.resolvePermissionSources(ctx, targetUserID, req.Msg.ServerId, req.Msg.ChannelId)
		if srcErr != nil {
			slog.Error("resolving permission sources", "err", srcErr, "user", targetUserID, "server", req.Msg.ServerId)
			// Non-fatal: return permissions without sources rather than failing.
		} else {
			resp.Sources = sources
		}
	}

	return connect.NewResponse(resp), nil
}

func (s *chatService) StreamEvents(context.Context, *connect.Request[v1.StreamEventsRequest], *connect.ServerStream[v1.Event]) error {
	return connect.NewError(connect.CodeUnimplemented, errors.New("not implemented"))
}

// Proto conversion helpers.

func serverToProto(s *models.Server) *v1.Server {
	srv := &v1.Server{
		Id:                     s.ID,
		Name:                   s.Name,
		OwnerId:                s.OwnerID,
		CreatedAt:              timestamppb.New(s.CreatedAt),
		OnboardingEnabled:      s.OnboardingEnabled,
		RulesRequired:          s.RulesRequired,
		DefaultChannelPrivacy:  s.DefaultChannelPrivacy,
	}
	if s.IconURL != nil {
		srv.IconUrl = *s.IconURL
	}
	if s.WelcomeMessage != nil {
		srv.WelcomeMessage = *s.WelcomeMessage
	}
	if s.Rules != nil {
		srv.Rules = *s.Rules
	}
	return srv
}

func channelToProto(c *models.Channel) *v1.Channel {
	ch := &v1.Channel{
		Id:        c.ID,
		ServerId:  c.ServerID,
		Name:      c.Name,
		Type:      v1.ChannelType(c.Type),
		Topic:     c.Topic,
		Position:  int32(c.Position),
		IsPrivate: c.IsPrivate,
		IsDefault: c.IsDefault,
		CreatedAt: timestamppb.New(c.CreatedAt),
	}
	if c.SlowModeSeconds != nil {
		sm := int32(*c.SlowModeSeconds)
		ch.SlowModeSeconds = &sm
	}
	if c.ChannelGroupID != "" {
		ch.ChannelGroupId = &c.ChannelGroupID
	}
	if c.DMStatus != "" {
		ch.DmStatus = &c.DMStatus
	}
	if c.DMInitiatorID != "" {
		ch.DmInitiatorId = &c.DMInitiatorID
	}
	return ch
}

func inviteToProto(inv *models.Invite) *v1.Invite {
	p := &v1.Invite{
		Code:      inv.Code,
		ServerId:  inv.ServerID,
		CreatorId: inv.CreatorID,
		MaxUses:   int32(inv.MaxUses),
		UseCount:  int32(inv.UseCount),
		Revoked:   inv.Revoked,
		CreatedAt: timestamppb.New(inv.CreatedAt),
	}
	if inv.ExpiresAt != nil {
		p.ExpiresAt = timestamppb.New(*inv.ExpiresAt)
	}
	return p
}

func attachmentToProto(a *models.Attachment) *v1.Attachment {
	var microThumb []byte
	if a.MicroThumbnailData != "" {
		microThumb, _ = base64.StdEncoding.DecodeString(a.MicroThumbnailData)
	}
	// For encrypted uploads, expose the original content type (not application/octet-stream).
	contentType := a.ContentType
	if a.OriginalContentType != "" {
		contentType = a.OriginalContentType
	}
	return &v1.Attachment{
		Id:             a.ID,
		Filename:       a.Filename,
		ContentType:    contentType,
		SizeBytes:      a.SizeBytes,
		Url:            fmt.Sprintf("/media/%s", a.ID),
		EncryptedKey:   a.EncryptedKey,
		Width:          int32(a.Width),
		Height:         int32(a.Height),
		HasThumbnail:   a.ThumbnailKey != "",
		MicroThumbnail: microThumb,
	}
}

func toProtoAttachments(ids []string, m map[string]*models.Attachment) []*v1.Attachment {
	out := make([]*v1.Attachment, 0, len(ids))
	for _, id := range ids {
		if a, ok := m[id]; ok {
			out = append(out, attachmentToProto(a))
		}
	}
	return out
}

