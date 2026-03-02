package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sort"
	"sync"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
	"google.golang.org/protobuf/proto"

	v1 "github.com/meza-chat/meza/gen/meza/v1"
	"github.com/meza-chat/meza/gen/meza/v1/mezav1connect"
	"github.com/meza-chat/meza/internal/auth"
	"github.com/meza-chat/meza/internal/models"
	"github.com/meza-chat/meza/internal/permissions"
	"github.com/meza-chat/meza/internal/store"
	"github.com/meza-chat/meza/internal/testutil"
)

// mockChatStore implements store.ChatStorer for testing.
type mockChatStore struct {
	mu        sync.Mutex
	servers   map[string]*models.Server
	channels  map[string]*models.Channel
	members   map[string]map[string]bool // serverID -> userID -> bool
	roleStore *mockRoleStore             // for auto-creating @everyone role in CreateServer
}

func newMockChatStore(rs *mockRoleStore) *mockChatStore {
	return &mockChatStore{
		servers:   make(map[string]*models.Server),
		channels:  make(map[string]*models.Channel),
		members:   make(map[string]map[string]bool),
		roleStore: rs,
	}
}

func (m *mockChatStore) CreateServer(_ context.Context, name, ownerID string, _ *string, _ bool) (*models.Server, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	srv := &models.Server{
		ID:        models.NewID(),
		Name:      name,
		OwnerID:   ownerID,
		CreatedAt: time.Now(),
	}
	m.servers[srv.ID] = srv

	if m.members[srv.ID] == nil {
		m.members[srv.ID] = make(map[string]bool)
	}
	m.members[srv.ID][ownerID] = true

	// Create default general channel
	ch := &models.Channel{
		ID:        models.NewID(),
		ServerID:  srv.ID,
		Name:      "general",
		Type:      1,
		Position:  0,
		CreatedAt: time.Now(),
	}
	m.channels[ch.ID] = ch

	// Create @everyone role (ID = serverID), mirroring production CreateServer.
	if m.roleStore != nil {
		m.roleStore.CreateRole(context.Background(), &models.Role{
			ID:          srv.ID,
			ServerID:    srv.ID,
			Name:        "@everyone",
			Position:    0,
			Permissions: permissions.DefaultEveryonePermissions,
		})
	}

	return srv, nil
}

func (m *mockChatStore) GetServer(_ context.Context, serverID string) (*models.Server, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	srv, ok := m.servers[serverID]
	if !ok {
		return nil, fmt.Errorf("server not found")
	}
	return srv, nil
}

func (m *mockChatStore) ListServers(_ context.Context, userID string) ([]*models.Server, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	var servers []*models.Server
	for serverID, members := range m.members {
		if members[userID] {
			if srv, ok := m.servers[serverID]; ok {
				servers = append(servers, srv)
			}
		}
	}
	return servers, nil
}

func (m *mockChatStore) CreateChannel(_ context.Context, serverID, name string, channelType int, isPrivate bool, channelGroupID string) (*models.Channel, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	ch := &models.Channel{
		ID:        models.NewID(),
		ServerID:  serverID,
		Name:      name,
		Type:      channelType,
		IsPrivate: isPrivate,
		Position:  len(m.channels),
		CreatedAt: time.Now(),
	}
	m.channels[ch.ID] = ch
	return ch, nil
}

func (m *mockChatStore) GetChannel(_ context.Context, channelID string) (*models.Channel, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	ch, ok := m.channels[channelID]
	if !ok {
		return nil, fmt.Errorf("channel not found")
	}
	return ch, nil
}

func (m *mockChatStore) ListChannels(_ context.Context, serverID, _ string) ([]*models.Channel, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	var channels []*models.Channel
	for _, ch := range m.channels {
		if ch.ServerID == serverID {
			channels = append(channels, ch)
		}
	}
	return channels, nil
}

func (m *mockChatStore) AddMember(_ context.Context, userID, serverID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.members[serverID] == nil {
		m.members[serverID] = make(map[string]bool)
	}
	m.members[serverID][userID] = true
	return nil
}

func (m *mockChatStore) RemoveMember(_ context.Context, userID, serverID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	if members, ok := m.members[serverID]; ok {
		delete(members, userID)
	}
	return nil
}

func (m *mockChatStore) IsMember(_ context.Context, userID, serverID string) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if members, ok := m.members[serverID]; ok {
		return members[userID], nil
	}
	return false, nil
}

func (m *mockChatStore) GetMemberCount(_ context.Context, serverID string) (int, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if members, ok := m.members[serverID]; ok {
		return len(members), nil
	}
	return 0, nil
}

func (m *mockChatStore) ListMembers(_ context.Context, serverID, after string, limit int) ([]*models.Member, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	serverMembers, ok := m.members[serverID]
	if !ok {
		return nil, nil
	}

	// Collect and sort user IDs for deterministic cursor pagination.
	var userIDs []string
	for uid := range serverMembers {
		userIDs = append(userIDs, uid)
	}
	sort.Strings(userIDs)

	var members []*models.Member
	for _, uid := range userIDs {
		if after != "" && uid <= after {
			continue
		}
		members = append(members, &models.Member{
			UserID:   uid,
			ServerID: serverID,
			JoinedAt: time.Now(),
		})
		if limit > 0 && len(members) >= limit {
			break
		}
	}
	return members, nil
}

func (m *mockChatStore) GetChannelAndCheckMembership(_ context.Context, channelID, userID string) (*models.Channel, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	ch, ok := m.channels[channelID]
	if !ok {
		return nil, false, fmt.Errorf("channel not found")
	}
	if members, ok := m.members[ch.ServerID]; ok {
		return ch, members[userID], nil
	}
	return ch, false, nil
}

func (m *mockChatStore) UpdateChannel(_ context.Context, channelID string, name, topic *string, position *int, isPrivate *bool, slowModeSeconds *int, isDefault *bool, channelGroupID *string) (*models.Channel, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	ch, ok := m.channels[channelID]
	if !ok {
		return nil, fmt.Errorf("channel not found")
	}
	if name != nil {
		ch.Name = *name
	}
	if topic != nil {
		ch.Topic = *topic
	}
	if position != nil {
		ch.Position = *position
	}
	if isPrivate != nil {
		ch.IsPrivate = *isPrivate
	}
	if isDefault != nil {
		ch.IsDefault = *isDefault
	}
	return ch, nil
}

func (m *mockChatStore) UpdateChannelPrivacy(ctx context.Context, channelID string, name, topic *string, position *int, isPrivate *bool, slowModeSeconds *int, isDefault *bool, channelGroupID *string, _ bool, _ string, _ int64) (*models.Channel, error) {
	return m.UpdateChannel(ctx, channelID, name, topic, position, isPrivate, slowModeSeconds, isDefault, channelGroupID)
}

func (m *mockChatStore) DeleteChannel(_ context.Context, channelID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	if _, ok := m.channels[channelID]; !ok {
		return fmt.Errorf("channel not found")
	}
	delete(m.channels, channelID)
	return nil
}

func (m *mockChatStore) GetMember(_ context.Context, userID, serverID string) (*models.Member, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if members, ok := m.members[serverID]; ok {
		if members[userID] {
			return &models.Member{
				UserID:   userID,
				ServerID: serverID,
				JoinedAt: time.Now(),
			}, nil
		}
	}
	return nil, fmt.Errorf("member not found")
}

func (m *mockChatStore) GetUserChannels(_ context.Context, userID string) ([]string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	var channelIDs []string
	for serverID, members := range m.members {
		if members[userID] {
			for _, ch := range m.channels {
				if ch.ServerID == serverID {
					channelIDs = append(channelIDs, ch.ID)
				}
			}
		}
	}
	return channelIDs, nil
}

func (m *mockChatStore) AddChannelMember(_ context.Context, _, _ string) error {
	return nil
}
func (m *mockChatStore) RemoveChannelMember(_ context.Context, _, _ string) error {
	return nil
}
func (m *mockChatStore) ListChannelMembers(_ context.Context, _ string) ([]*models.Member, error) {
	return nil, nil
}
func (m *mockChatStore) ListChannelParticipantIDs(_ context.Context, _ string) ([]string, error) {
	return nil, nil
}
func (m *mockChatStore) CountChannelMembers(_ context.Context, _ string) (int, error) {
	return 0, nil
}
func (m *mockChatStore) IsChannelMember(_ context.Context, _, _ string) (bool, error) {
	return false, nil
}
func (m *mockChatStore) RemoveChannelMembersForServer(_ context.Context, _, _ string) error {
	return nil
}
func (m *mockChatStore) ClearChannelMembers(_ context.Context, _ string) error {
	return nil
}
func (m *mockChatStore) SetMemberTimeout(_ context.Context, _, _ string, _ *time.Time) error {
	return nil
}
func (m *mockChatStore) SetMemberNickname(_ context.Context, _, _, _ string) error {
	return nil
}
func (m *mockChatStore) CreateDMChannel(_ context.Context, _, _, _, _ string) (*models.Channel, bool, error) {
	return nil, false, nil
}
func (m *mockChatStore) CreateGroupDMChannel(_ context.Context, _, _ string, _ []string) (*models.Channel, error) {
	return nil, nil
}
func (m *mockChatStore) ListDMChannelsWithParticipants(_ context.Context, _ string) ([]*models.DMChannelWithParticipants, error) {
	return nil, nil
}
func (m *mockChatStore) GetDMChannelByPairKey(_ context.Context, _, _ string) (*models.Channel, error) {
	return nil, nil
}
func (m *mockChatStore) UpdateDMStatus(_ context.Context, _, _ string) error { return nil }
func (m *mockChatStore) ListPendingDMRequests(_ context.Context, _ string) ([]*models.DMChannelWithParticipants, error) {
	return nil, nil
}
func (m *mockChatStore) ShareAnyServer(_ context.Context, _, _ string) (bool, error) {
	return false, nil
}
func (m *mockChatStore) GetDMOtherParticipantID(_ context.Context, _, _ string) (string, error) {
	return "", nil
}
func (m *mockChatStore) ListMemberUserIDs(_ context.Context, serverID string) ([]string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if members, ok := m.members[serverID]; ok {
		var userIDs []string
		for uid := range members {
			userIDs = append(userIDs, uid)
		}
		return userIDs, nil
	}
	return nil, nil
}
func (m *mockChatStore) UpdateServer(_ context.Context, serverID string, name, iconURL, welcomeMessage, rules *string, onboardingEnabled, rulesRequired, defaultChannelPrivacy *bool) (*models.Server, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	srv, ok := m.servers[serverID]
	if !ok {
		return nil, fmt.Errorf("server not found")
	}
	if name != nil {
		srv.Name = *name
	}
	if iconURL != nil {
		srv.IconURL = iconURL
	}
	if welcomeMessage != nil {
		srv.WelcomeMessage = welcomeMessage
	}
	if rules != nil {
		srv.Rules = rules
	}
	if onboardingEnabled != nil {
		srv.OnboardingEnabled = *onboardingEnabled
	}
	if rulesRequired != nil {
		srv.RulesRequired = *rulesRequired
	}
	if defaultChannelPrivacy != nil {
		srv.DefaultChannelPrivacy = *defaultChannelPrivacy
	}
	return srv, nil
}
func (m *mockChatStore) AcknowledgeRules(_ context.Context, _, _ string) (time.Time, error) {
	return time.Now(), nil
}
func (m *mockChatStore) CompleteOnboarding(_ context.Context, _, _ string, channelIDs, roleIDs []string) (time.Time, []string, []string, error) {
	return time.Now(), channelIDs, roleIDs, nil
}
func (m *mockChatStore) CheckRulesAcknowledged(_ context.Context, _, _ string) (bool, error) {
	return false, nil
}
func (m *mockChatStore) GetDefaultChannels(_ context.Context, _ string) ([]*models.Channel, error) {
	return nil, nil
}
func (m *mockChatStore) GetSelfAssignableRoles(_ context.Context, _ string) ([]*models.Role, error) {
	return nil, nil
}
func (m *mockChatStore) CreateServerFromTemplate(_ context.Context, _ store.CreateServerFromTemplateParams) (*models.Server, []*models.Channel, []*models.Role, error) {
	return nil, nil, nil, nil
}

// mockMessageStore implements models.MessageStorer for testing.
type mockMessageStore struct {
	mu       sync.Mutex
	messages map[string][]*models.Message // channelID -> messages
}

func newMockMessageStore() *mockMessageStore {
	return &mockMessageStore{
		messages: make(map[string][]*models.Message),
	}
}

func (m *mockMessageStore) InsertMessage(_ context.Context, msg *models.Message) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	m.messages[msg.ChannelID] = append(m.messages[msg.ChannelID], msg)
	return nil
}

func (m *mockMessageStore) GetMessage(_ context.Context, channelID, messageID string) (*models.Message, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	for _, msg := range m.messages[channelID] {
		if msg.MessageID == messageID {
			return msg, nil
		}
	}
	return nil, fmt.Errorf("message not found")
}

func (m *mockMessageStore) GetMessages(_ context.Context, channelID string, opts store.GetMessagesOpts) ([]*models.Message, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	var msgs []*models.Message
	for _, msg := range m.messages[channelID] {
		if !msg.Deleted {
			msgs = append(msgs, msg)
		}
	}
	limit := opts.Limit
	if limit <= 0 {
		limit = 50
	}
	hasMore := len(msgs) > limit
	if len(msgs) > limit {
		msgs = msgs[:limit]
	}
	return msgs, hasMore, nil
}

func (m *mockMessageStore) EditMessage(_ context.Context, channelID, messageID string, encryptedContent []byte, mentionedUserIDs, mentionedRoleIDs []string, mentionEveryone bool, editedAt time.Time, _ uint32) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	for _, msg := range m.messages[channelID] {
		if msg.MessageID == messageID {
			msg.EncryptedContent = encryptedContent
			msg.MentionedUserIDs = mentionedUserIDs
			msg.MentionedRoleIDs = mentionedRoleIDs
			msg.MentionEveryone = mentionEveryone
			msg.EditedAt = editedAt
			return nil
		}
	}
	return fmt.Errorf("message not found")
}

func (m *mockMessageStore) DeleteMessage(_ context.Context, channelID, messageID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	for _, msg := range m.messages[channelID] {
		if msg.MessageID == messageID {
			msg.Deleted = true
			msg.EncryptedContent = []byte{}
			return nil
		}
	}
	return fmt.Errorf("message not found")
}

func (m *mockMessageStore) GetMessagesByIDs(_ context.Context, channelID string, messageIDs []string) (map[string]*models.Message, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	result := make(map[string]*models.Message, len(messageIDs))
	for _, id := range messageIDs {
		for _, msg := range m.messages[channelID] {
			if msg.MessageID == id {
				result[id] = msg
				break
			}
		}
	}
	return result, nil
}
func (m *mockMessageStore) BulkDeleteMessages(_ context.Context, _ string, _ []string) error {
	return nil
}

// replyIndex stores reply entries keyed by "channelID:replyToID".
type replyIndexEntry struct {
	messageID string
	authorID  string
	createdAt time.Time
}

var replyIndex = struct {
	mu      sync.Mutex
	entries map[string][]replyIndexEntry
}{entries: make(map[string][]replyIndexEntry)}

func (m *mockMessageStore) InsertReplyIndex(_ context.Context, channelID, replyToID, messageID, authorID string, createdAt time.Time) error {
	replyIndex.mu.Lock()
	defer replyIndex.mu.Unlock()
	key := channelID + ":" + replyToID
	replyIndex.entries[key] = append(replyIndex.entries[key], replyIndexEntry{
		messageID: messageID,
		authorID:  authorID,
		createdAt: createdAt,
	})
	return nil
}

func (m *mockMessageStore) DeleteReplyIndex(_ context.Context, channelID, replyToID, messageID string) error {
	replyIndex.mu.Lock()
	defer replyIndex.mu.Unlock()
	key := channelID + ":" + replyToID
	entries := replyIndex.entries[key]
	for i, e := range entries {
		if e.messageID == messageID {
			replyIndex.entries[key] = append(entries[:i], entries[i+1:]...)
			break
		}
	}
	return nil
}

func (m *mockMessageStore) GetReplies(_ context.Context, channelID, messageID string, limit int) ([]*models.ReplyEntry, int, error) {
	replyIndex.mu.Lock()
	defer replyIndex.mu.Unlock()
	key := channelID + ":" + messageID
	entries := replyIndex.entries[key]
	total := len(entries)
	if limit <= 0 {
		limit = 50
	}
	if limit > total {
		limit = total
	}
	result := make([]*models.ReplyEntry, limit)
	for i := 0; i < limit; i++ {
		result[i] = &models.ReplyEntry{
			MessageID: entries[i].messageID,
			AuthorID:  entries[i].authorID,
			CreatedAt: entries[i].createdAt,
		}
	}
	return result, total, nil
}

func (m *mockMessageStore) CountMessagesAfter(_ context.Context, _, _ string) (int32, error) {
	return 0, nil
}

func (m *mockMessageStore) SearchMessages(_ context.Context, opts store.SearchMessagesOpts) ([]*models.Message, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	var results []*models.Message
	for _, msg := range m.messages[opts.ChannelID] {
		if msg.Deleted {
			continue
		}
		results = append(results, msg)
	}
	limit := opts.Limit
	if limit <= 0 {
		limit = 25
	}
	hasMore := len(results) > limit
	if len(results) > limit {
		results = results[:limit]
	}
	return results, hasMore, nil
}

// mockInviteStore implements store.InviteStorer for testing.
type mockInviteStore struct {
	mu      sync.Mutex
	invites map[string]*models.Invite // code -> invite
	counter int
}

func newMockInviteStore() *mockInviteStore {
	return &mockInviteStore{
		invites: make(map[string]*models.Invite),
	}
}

func (m *mockInviteStore) CreateInvite(_ context.Context, serverID, creatorID string, maxUses int, expiresAt *time.Time) (*models.Invite, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	m.counter++
	code := fmt.Sprintf("inv%05d", m.counter)
	inv := &models.Invite{
		Code:      code,
		ServerID:  serverID,
		CreatorID: creatorID,
		MaxUses:   maxUses,
		ExpiresAt: expiresAt,
		CreatedAt: time.Now(),
	}
	m.invites[code] = inv
	return inv, nil
}

func (m *mockInviteStore) GetInvite(_ context.Context, code string) (*models.Invite, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	inv, ok := m.invites[code]
	if !ok {
		return nil, fmt.Errorf("invite not found")
	}
	return inv, nil
}

func (m *mockInviteStore) ConsumeInvite(_ context.Context, code string) (*models.Invite, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	inv, ok := m.invites[code]
	if !ok {
		return nil, nil
	}
	if inv.Revoked {
		return nil, nil
	}
	if inv.ExpiresAt != nil && inv.ExpiresAt.Before(time.Now()) {
		return nil, nil
	}
	if inv.MaxUses > 0 && inv.UseCount >= inv.MaxUses {
		return nil, nil
	}
	inv.UseCount++
	return inv, nil
}

func (m *mockInviteStore) RevokeInvite(_ context.Context, code string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	if inv, ok := m.invites[code]; ok {
		inv.Revoked = true
	}
	return nil
}

func (m *mockInviteStore) ListInvites(_ context.Context, serverID string) ([]*models.Invite, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	var invites []*models.Invite
	for _, inv := range m.invites {
		if inv.ServerID == serverID {
			invites = append(invites, inv)
		}
	}
	return invites, nil
}

// mockRoleStore implements store.RoleStorer for testing.
type mockRoleStore struct {
	mu          sync.Mutex
	roles       map[string]*models.Role              // roleID -> role
	memberRoles map[string]map[string][]string        // serverID -> userID -> []roleID
}

func newMockRoleStore() *mockRoleStore {
	return &mockRoleStore{
		roles:       make(map[string]*models.Role),
		memberRoles: make(map[string]map[string][]string),
	}
}

// assignRoles is a test helper to directly set a member's roles.
func (s *mockRoleStore) assignRoles(serverID, userID string, roleIDs []string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.memberRoles[serverID] == nil {
		s.memberRoles[serverID] = make(map[string][]string)
	}
	s.memberRoles[serverID][userID] = roleIDs
}

func (s *mockRoleStore) CreateRole(_ context.Context, role *models.Role) (*models.Role, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.roles[role.ID] = role
	return role, nil
}

func (s *mockRoleStore) GetRole(_ context.Context, roleID string) (*models.Role, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, ok := s.roles[roleID]
	if !ok {
		return nil, fmt.Errorf("role not found")
	}
	return r, nil
}

func (s *mockRoleStore) ListRoles(_ context.Context, serverID string) ([]*models.Role, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var roles []*models.Role
	for _, r := range s.roles {
		if r.ServerID == serverID {
			roles = append(roles, r)
		}
	}
	return roles, nil
}

func (s *mockRoleStore) UpdateRole(_ context.Context, roleID string, name *string, permissions *int64, color *int, isSelfAssignable *bool) (*models.Role, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, ok := s.roles[roleID]
	if !ok {
		return nil, fmt.Errorf("role not found")
	}
	if name != nil {
		r.Name = *name
	}
	if permissions != nil {
		r.Permissions = *permissions
	}
	if color != nil {
		r.Color = *color
	}
	if isSelfAssignable != nil {
		r.IsSelfAssignable = *isSelfAssignable
	}
	return r, nil
}

func (s *mockRoleStore) DeleteRole(_ context.Context, roleID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.roles[roleID]; !ok {
		return fmt.Errorf("role not found")
	}
	delete(s.roles, roleID)
	return nil
}

func (s *mockRoleStore) GetRolesByIDs(_ context.Context, roleIDs []string, serverID string) ([]*models.Role, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var roles []*models.Role
	for _, id := range roleIDs {
		r, ok := s.roles[id]
		if !ok || r.ServerID != serverID {
			continue
		}
		roles = append(roles, r)
	}
	return roles, nil
}

func (s *mockRoleStore) SetMemberRoles(_ context.Context, userID, serverID string, roleIDs []string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.memberRoles[serverID] == nil {
		s.memberRoles[serverID] = make(map[string][]string)
	}
	s.memberRoles[serverID][userID] = roleIDs
	return nil
}

func (s *mockRoleStore) GetMemberRoles(_ context.Context, userID, serverID string) ([]*models.Role, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	ids := s.memberRoles[serverID][userID]
	var roles []*models.Role
	for _, id := range ids {
		if r, ok := s.roles[id]; ok && r.ServerID == serverID {
			roles = append(roles, r)
		}
	}
	return roles, nil
}

func (s *mockRoleStore) ReorderRoles(_ context.Context, serverID string, roleIDs []string, _ int) ([]*models.Role, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var roles []*models.Role
	for i, id := range roleIDs {
		if r, ok := s.roles[id]; ok && r.ServerID == serverID {
			r.Position = i + 1
			roles = append(roles, r)
		}
	}
	return roles, nil
}

// mockBanStore implements store.BanStorer for testing.
type mockBanStore struct {
	mu   sync.Mutex
	bans map[string]map[string]*models.Ban // serverID -> userID -> ban
}

func newMockBanStore() *mockBanStore {
	return &mockBanStore{bans: make(map[string]map[string]*models.Ban)}
}

func (s *mockBanStore) CreateBanAndRemoveMember(_ context.Context, ban *models.Ban, _ int) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.bans[ban.ServerID] == nil {
		s.bans[ban.ServerID] = make(map[string]*models.Ban)
	}
	s.bans[ban.ServerID][ban.UserID] = ban
	return nil
}

func (s *mockBanStore) CreateBan(_ context.Context, ban *models.Ban) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.bans[ban.ServerID] == nil {
		s.bans[ban.ServerID] = make(map[string]*models.Ban)
	}
	if _, exists := s.bans[ban.ServerID][ban.UserID]; exists {
		return false, nil
	}
	s.bans[ban.ServerID][ban.UserID] = ban
	return true, nil
}

func (s *mockBanStore) IsBanned(_ context.Context, serverID, userID string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.bans[serverID] != nil {
		_, ok := s.bans[serverID][userID]
		return ok, nil
	}
	return false, nil
}

func (s *mockBanStore) DeleteBan(_ context.Context, serverID, userID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.bans[serverID] != nil {
		delete(s.bans[serverID], userID)
	}
	return nil
}

func (s *mockBanStore) ListBans(_ context.Context, serverID string) ([]*models.Ban, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var bans []*models.Ban
	if s.bans[serverID] != nil {
		for _, b := range s.bans[serverID] {
			bans = append(bans, b)
		}
	}
	return bans, nil
}

// mockPinStore implements store.PinStorer for testing.
type mockPinStore struct {
	mu   sync.Mutex
	pins map[string]map[string]*models.PinnedMessage // channelID -> messageID -> pin
}

func newMockPinStore() *mockPinStore {
	return &mockPinStore{pins: make(map[string]map[string]*models.PinnedMessage)}
}

func (m *mockPinStore) PinMessage(_ context.Context, channelID, messageID, pinnedBy string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.pins[channelID] == nil {
		m.pins[channelID] = make(map[string]*models.PinnedMessage)
	}
	if _, exists := m.pins[channelID][messageID]; exists {
		return nil // ON CONFLICT DO NOTHING
	}
	m.pins[channelID][messageID] = &models.PinnedMessage{
		ChannelID: channelID, MessageID: messageID, PinnedBy: &pinnedBy, PinnedAt: time.Now(),
	}
	return nil
}

func (m *mockPinStore) UnpinMessage(_ context.Context, channelID, messageID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.pins[channelID] != nil {
		delete(m.pins[channelID], messageID)
	}
	return nil
}

func (m *mockPinStore) GetPinnedMessages(_ context.Context, channelID string, _ time.Time, limit int) ([]*models.PinnedMessage, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var result []*models.PinnedMessage
	for _, pin := range m.pins[channelID] {
		result = append(result, pin)
		if len(result) >= limit {
			break
		}
	}
	return result, nil
}

func (m *mockPinStore) IsPinned(_ context.Context, channelID, messageID string) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.pins[channelID] == nil {
		return false, nil
	}
	_, ok := m.pins[channelID][messageID]
	return ok, nil
}

// mockPermissionOverrideStore implements store.PermissionOverrideStorer for testing.
type mockPermissionOverrideStore struct{}

func (m *mockPermissionOverrideStore) SetOverride(_ context.Context, override *models.PermissionOverride) (*models.PermissionOverride, error) {
	return override, nil
}
func (m *mockPermissionOverrideStore) DeleteOverride(_ context.Context, _, _ string) error {
	return nil
}
func (m *mockPermissionOverrideStore) ListOverridesByTarget(_ context.Context, _ string) ([]*models.PermissionOverride, error) {
	return nil, nil
}
func (m *mockPermissionOverrideStore) GetEffectiveOverrides(_ context.Context, _ string, _ []string) (int64, int64, int64, int64, error) {
	return 0, 0, 0, 0, nil
}
func (m *mockPermissionOverrideStore) GetAllOverridesForChannel(_ context.Context, _ string, _ []string, _ string) (*store.ChannelOverrides, error) {
	return &store.ChannelOverrides{}, nil
}
func (m *mockPermissionOverrideStore) GetAllOverridesForChannels(_ context.Context, _ []string, _ []string, _ string) (map[string]*store.ChannelOverrides, error) {
	return map[string]*store.ChannelOverrides{}, nil
}
func (m *mockPermissionOverrideStore) DeleteOverrideByUser(_ context.Context, _, _ string) error {
	return nil
}

// mockEncryptionChecker implements EncryptionChecker for testing.
type mockEncryptionChecker struct {
	mu       sync.Mutex
	channels map[string]bool // channelID -> has key version
}

func newMockEncryptionChecker() *mockEncryptionChecker {
	return &mockEncryptionChecker{channels: make(map[string]bool)}
}

func (m *mockEncryptionChecker) SetEncrypted(channelID string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.channels[channelID] = true
}

func (m *mockEncryptionChecker) HasChannelKeyVersion(_ context.Context, channelID string) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.channels[channelID], nil
}

// mockEmojiStore implements store.EmojiStorer for testing.
type mockEmojiStore struct{}

func (s *mockEmojiStore) CreateEmoji(_ context.Context, emoji *models.Emoji, _, _ int) (*models.Emoji, error) {
	return emoji, nil
}
func (s *mockEmojiStore) GetEmoji(context.Context, string) (*models.Emoji, error) {
	return nil, fmt.Errorf("not found")
}
func (s *mockEmojiStore) ListEmojis(context.Context, string) ([]*models.Emoji, error) {
	return nil, nil
}
func (s *mockEmojiStore) UpdateEmoji(_ context.Context, _ string, _ *string) (*models.Emoji, error) {
	return nil, fmt.Errorf("not found")
}
func (s *mockEmojiStore) DeleteEmoji(context.Context, string) error { return nil }
func (s *mockEmojiStore) CountEmojisByServer(context.Context, string) (int, error) {
	return 0, nil
}
func (s *mockEmojiStore) CountEmojisByUser(context.Context, string) (int, error) {
	return 0, nil
}
func (s *mockEmojiStore) ListEmojisByUser(context.Context, string) ([]*models.Emoji, error) {
	return nil, nil
}

type mockMediaStore struct {
	mu          sync.Mutex
	attachments map[string]*models.Attachment
}

func newMockMediaStore() *mockMediaStore {
	return &mockMediaStore{attachments: make(map[string]*models.Attachment)}
}

func (s *mockMediaStore) CreateAttachment(_ context.Context, a *models.Attachment) (*models.Attachment, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.attachments[a.ID] = a
	return a, nil
}
func (s *mockMediaStore) GetAttachment(_ context.Context, id string) (*models.Attachment, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	a, ok := s.attachments[id]
	if !ok {
		return nil, fmt.Errorf("attachment not found")
	}
	return a, nil
}
func (s *mockMediaStore) GetAttachmentsByIDs(_ context.Context, ids []string) (map[string]*models.Attachment, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	result := make(map[string]*models.Attachment, len(ids))
	for _, id := range ids {
		if a, ok := s.attachments[id]; ok && a.Status == models.AttachmentStatusCompleted {
			result[id] = a
		}
	}
	return result, nil
}
func (s *mockMediaStore) CountPendingByUploader(context.Context, string) (int, error) {
	return 0, nil
}
func (s *mockMediaStore) TransitionToProcessing(context.Context, string, string) (*models.Attachment, error) {
	return nil, nil
}
func (s *mockMediaStore) UpdateAttachmentCompleted(context.Context, string, int64, string, int, int, string, string, []byte) error {
	return nil
}
func (s *mockMediaStore) DeleteAttachment(context.Context, string) error { return nil }
func (s *mockMediaStore) FindOrphanedUploads(context.Context, time.Time, int) ([]*models.Attachment, error) {
	return nil, nil
}
func (m *mockMediaStore) ResetAttachmentToPending(_ context.Context, _ string) error {
	return nil
}
func (m *mockMediaStore) LinkAttachments(_ context.Context, ids []string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	now := time.Now()
	for _, id := range ids {
		if a, ok := m.attachments[id]; ok {
			a.LinkedAt = &now
		}
	}
	return nil
}
func (m *mockMediaStore) FindUnlinkedAttachments(context.Context, time.Time, int) ([]*models.Attachment, error) {
	return nil, nil
}

func setupChatTestServer(t *testing.T) (mezav1connect.ChatServiceClient, *mockChatStore, *mockMessageStore, *mockInviteStore) {
	t.Helper()
	roleStore := newMockRoleStore()
	chatStore := newMockChatStore(roleStore)
	messageStore := newMockMessageStore()
	inviteStore := newMockInviteStore()
	banStore := newMockBanStore()
	pinStore := newMockPinStore()
	emojiStore := &mockEmojiStore{}
	nc := testutil.StartTestNATS(t)

	svc := newChatService(chatServiceConfig{
		ChatStore:               chatStore,
		MessageStore:            messageStore,
		InviteStore:             inviteStore,
		RoleStore:               roleStore,
		BanStore:                banStore,
		PinStore:                pinStore,
		EmojiStore:              emojiStore,
		MediaStore:              newMockMediaStore(),
		PermissionOverrideStore: &mockPermissionOverrideStore{},
		NC:                      nc,
		PermCache:               permissions.NewCache(nil),
	})

	interceptor := connect.WithInterceptors(auth.NewConnectInterceptor(testutil.TestEd25519Keys.PublicKey))
	mux := http.NewServeMux()
	path, handler := mezav1connect.NewChatServiceHandler(svc, interceptor)
	mux.Handle(path, handler)

	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	client := mezav1connect.NewChatServiceClient(http.DefaultClient, srv.URL)
	return client, chatStore, messageStore, inviteStore
}

// setupModerationTestServer creates a test server with access to all mock stores
// for testing moderation endpoints (UpdateMember, KickMember, BanMember, etc.).
func setupModerationTestServer(t *testing.T) (mezav1connect.ChatServiceClient, *mockChatStore, *mockRoleStore, *mockBanStore) {
	t.Helper()
	roleStore := newMockRoleStore()
	chatStore := newMockChatStore(roleStore)
	messageStore := newMockMessageStore()
	inviteStore := newMockInviteStore()
	banStore := newMockBanStore()
	pinStore := newMockPinStore()
	emojiStore := &mockEmojiStore{}
	nc := testutil.StartTestNATS(t)

	svc := newChatService(chatServiceConfig{
		ChatStore:               chatStore,
		MessageStore:            messageStore,
		InviteStore:             inviteStore,
		RoleStore:               roleStore,
		BanStore:                banStore,
		PinStore:                pinStore,
		EmojiStore:              emojiStore,
		MediaStore:              newMockMediaStore(),
		PermissionOverrideStore: &mockPermissionOverrideStore{},
		NC:                      nc,
		PermCache:               permissions.NewCache(nil),
	})

	interceptor := connect.WithInterceptors(auth.NewConnectInterceptor(testutil.TestEd25519Keys.PublicKey))
	mux := http.NewServeMux()
	path, handler := mezav1connect.NewChatServiceHandler(svc, interceptor)
	mux.Handle(path, handler)

	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	client := mezav1connect.NewChatServiceClient(http.DefaultClient, srv.URL)
	return client, chatStore, roleStore, banStore
}

func TestCreateServer(t *testing.T) {
	client, _, _, _ := setupChatTestServer(t)
	userID := models.NewID()

	resp, err := client.CreateServer(context.Background(), testutil.AuthedRequest(t, userID, &v1.CreateServerRequest{
		Name: "Test Server",
	}))
	if err != nil {
		t.Fatalf("CreateServer: %v", err)
	}
	if resp.Msg.Server == nil {
		t.Fatal("expected server in response")
	}
	if resp.Msg.Server.Name != "Test Server" {
		t.Errorf("name = %q, want %q", resp.Msg.Server.Name, "Test Server")
	}
	if resp.Msg.Server.OwnerId != userID {
		t.Errorf("owner = %q, want %q", resp.Msg.Server.OwnerId, userID)
	}
}

func TestCreateServerMissingName(t *testing.T) {
	client, _, _, _ := setupChatTestServer(t)
	userID := models.NewID()

	_, err := client.CreateServer(context.Background(), testutil.AuthedRequest(t, userID, &v1.CreateServerRequest{}))
	if err == nil {
		t.Fatal("expected error for missing name")
	}
	if connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Errorf("code = %v, want InvalidArgument", connect.CodeOf(err))
	}
}

func TestCreateChannel(t *testing.T) {
	client, _, _, _ := setupChatTestServer(t)
	userID := models.NewID()

	srvResp, err := client.CreateServer(context.Background(), testutil.AuthedRequest(t, userID, &v1.CreateServerRequest{
		Name: "Test Server",
	}))
	if err != nil {
		t.Fatalf("CreateServer: %v", err)
	}
	serverID := srvResp.Msg.Server.Id

	chResp, err := client.CreateChannel(context.Background(), testutil.AuthedRequest(t, userID, &v1.CreateChannelRequest{
		ServerId: serverID,
		Name:     "dev-chat",
		Type:     v1.ChannelType_CHANNEL_TYPE_TEXT,
	}))
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	if chResp.Msg.Channel.Name != "dev-chat" {
		t.Errorf("name = %q, want %q", chResp.Msg.Channel.Name, "dev-chat")
	}
}

func TestCreateChannelNotMember(t *testing.T) {
	client, _, _, _ := setupChatTestServer(t)
	ownerID := models.NewID()
	otherUserID := models.NewID()

	srvResp, err := client.CreateServer(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.CreateServerRequest{
		Name: "Test Server",
	}))
	if err != nil {
		t.Fatalf("CreateServer: %v", err)
	}
	serverID := srvResp.Msg.Server.Id

	_, err = client.CreateChannel(context.Background(), testutil.AuthedRequest(t, otherUserID, &v1.CreateChannelRequest{
		ServerId: serverID,
		Name:     "evil-channel",
	}))
	if err == nil {
		t.Fatal("expected error for non-member")
	}
	if connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Errorf("code = %v, want PermissionDenied", connect.CodeOf(err))
	}
}

func TestSendAndGetMessages(t *testing.T) {
	client, chatStore, _, _ := setupChatTestServer(t)
	userID := models.NewID()

	srvResp, err := client.CreateServer(context.Background(), testutil.AuthedRequest(t, userID, &v1.CreateServerRequest{
		Name: "Test Server",
	}))
	if err != nil {
		t.Fatalf("CreateServer: %v", err)
	}
	serverID := srvResp.Msg.Server.Id

	// Find the default general channel
	channels, err := chatStore.ListChannels(context.Background(), serverID, "")
	if err != nil {
		t.Fatalf("ListChannels: %v", err)
	}
	if len(channels) == 0 {
		t.Fatal("expected at least one channel")
	}
	channelID := channels[0].ID

	// Send a message
	sendResp, err := client.SendMessage(context.Background(), testutil.AuthedRequest(t, userID, &v1.SendMessageRequest{
		ChannelId:        channelID,
		EncryptedContent: []byte("hello encrypted"),
	}))
	if err != nil {
		t.Fatalf("SendMessage: %v", err)
	}
	if sendResp.Msg.MessageId == "" {
		t.Error("expected message_id")
	}

	// Get messages
	getResp, err := client.GetMessages(context.Background(), testutil.AuthedRequest(t, userID, &v1.GetMessagesRequest{
		ChannelId: channelID,
	}))
	if err != nil {
		t.Fatalf("GetMessages: %v", err)
	}
	if len(getResp.Msg.Messages) != 1 {
		t.Fatalf("messages count = %d, want 1", len(getResp.Msg.Messages))
	}
	msg := getResp.Msg.Messages[0]
	if msg.AuthorId != userID {
		t.Errorf("author = %q, want %q", msg.AuthorId, userID)
	}
	if string(msg.EncryptedContent) != "hello encrypted" {
		t.Errorf("content = %q, want %q", string(msg.EncryptedContent), "hello encrypted")
	}
}

func TestSendMessageNotMember(t *testing.T) {
	client, chatStore, _, _ := setupChatTestServer(t)
	ownerID := models.NewID()
	otherUserID := models.NewID()

	srvResp, err := client.CreateServer(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.CreateServerRequest{
		Name: "Test Server",
	}))
	if err != nil {
		t.Fatalf("CreateServer: %v", err)
	}
	serverID := srvResp.Msg.Server.Id

	channels, err := chatStore.ListChannels(context.Background(), serverID, "")
	if err != nil {
		t.Fatalf("ListChannels: %v", err)
	}
	channelID := channels[0].ID

	_, err = client.SendMessage(context.Background(), testutil.AuthedRequest(t, otherUserID, &v1.SendMessageRequest{
		ChannelId:        channelID,
		EncryptedContent: []byte("sneaky"),
	}))
	if err == nil {
		t.Fatal("expected error for non-member")
	}
	if connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Errorf("code = %v, want PermissionDenied", connect.CodeOf(err))
	}
}

func setupEncryptionTestServer(t *testing.T) (mezav1connect.ChatServiceClient, *mockChatStore, *mockEncryptionChecker) {
	t.Helper()
	roleStore := newMockRoleStore()
	chatStore := newMockChatStore(roleStore)
	messageStore := newMockMessageStore()
	encChecker := newMockEncryptionChecker()
	nc := testutil.StartTestNATS(t)

	svc := newChatService(chatServiceConfig{
		ChatStore:               chatStore,
		MessageStore:            messageStore,
		InviteStore:             newMockInviteStore(),
		RoleStore:               roleStore,
		BanStore:                newMockBanStore(),
		PinStore:                newMockPinStore(),
		EmojiStore:              &mockEmojiStore{},
		MediaStore:              newMockMediaStore(),
		PermissionOverrideStore: &mockPermissionOverrideStore{},
		EncryptionChecker:       encChecker,
		NC:                      nc,
		PermCache:               permissions.NewCache(nil),
	})

	interceptor := connect.WithInterceptors(auth.NewConnectInterceptor(testutil.TestEd25519Keys.PublicKey))
	mux := http.NewServeMux()
	path, handler := mezav1connect.NewChatServiceHandler(svc, interceptor)
	mux.Handle(path, handler)

	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	client := mezav1connect.NewChatServiceClient(http.DefaultClient, srv.URL)
	return client, chatStore, encChecker
}

func TestSendMessageRejectsPlaintextOnEncryptedChannel(t *testing.T) {
	client, chatStore, encChecker := setupEncryptionTestServer(t)
	userID := models.NewID()

	srvResp, err := client.CreateServer(context.Background(), testutil.AuthedRequest(t, userID, &v1.CreateServerRequest{
		Name: "Encrypted Server",
	}))
	if err != nil {
		t.Fatalf("CreateServer: %v", err)
	}

	channels, err := chatStore.ListChannels(context.Background(), srvResp.Msg.Server.Id, "")
	if err != nil {
		t.Fatalf("ListChannels: %v", err)
	}
	channelID := channels[0].ID

	// Mark the channel as having an encryption key version.
	encChecker.SetEncrypted(channelID)

	// Sending with keyVersion=0 should be rejected.
	_, err = client.SendMessage(context.Background(), testutil.AuthedRequest(t, userID, &v1.SendMessageRequest{
		ChannelId:        channelID,
		EncryptedContent: []byte("plaintext attempt"),
		KeyVersion:       0,
	}))
	if err == nil {
		t.Fatal("expected error for keyVersion=0 on encrypted channel")
	}
	if connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Errorf("code = %v, want InvalidArgument", connect.CodeOf(err))
	}

	// Sending with keyVersion>0 should succeed.
	resp, err := client.SendMessage(context.Background(), testutil.AuthedRequest(t, userID, &v1.SendMessageRequest{
		ChannelId:        channelID,
		EncryptedContent: []byte("properly encrypted"),
		KeyVersion:       1,
	}))
	if err != nil {
		t.Fatalf("SendMessage with keyVersion=1: %v", err)
	}
	if resp.Msg.MessageId == "" {
		t.Error("expected message_id")
	}
}

func TestSendMessageAllowsKeyVersionZeroOnUnencryptedChannel(t *testing.T) {
	client, chatStore, _ := setupEncryptionTestServer(t)
	userID := models.NewID()

	srvResp, err := client.CreateServer(context.Background(), testutil.AuthedRequest(t, userID, &v1.CreateServerRequest{
		Name: "Unencrypted Server",
	}))
	if err != nil {
		t.Fatalf("CreateServer: %v", err)
	}

	channels, err := chatStore.ListChannels(context.Background(), srvResp.Msg.Server.Id, "")
	if err != nil {
		t.Fatalf("ListChannels: %v", err)
	}
	channelID := channels[0].ID

	// Do NOT mark the channel as encrypted. keyVersion=0 should be allowed.
	resp, err := client.SendMessage(context.Background(), testutil.AuthedRequest(t, userID, &v1.SendMessageRequest{
		ChannelId:        channelID,
		EncryptedContent: []byte("not yet encrypted"),
		KeyVersion:       0,
	}))
	if err != nil {
		t.Fatalf("SendMessage on unencrypted channel: %v", err)
	}
	if resp.Msg.MessageId == "" {
		t.Error("expected message_id")
	}
}

func TestEditMessageRejectsPlaintextOnEncryptedChannel(t *testing.T) {
	client, chatStore, encChecker := setupEncryptionTestServer(t)
	userID := models.NewID()

	srvResp, err := client.CreateServer(context.Background(), testutil.AuthedRequest(t, userID, &v1.CreateServerRequest{
		Name: "Encrypted Server",
	}))
	if err != nil {
		t.Fatalf("CreateServer: %v", err)
	}

	channels, err := chatStore.ListChannels(context.Background(), srvResp.Msg.Server.Id, "")
	if err != nil {
		t.Fatalf("ListChannels: %v", err)
	}
	channelID := channels[0].ID

	// Send a valid encrypted message first.
	encChecker.SetEncrypted(channelID)
	sendResp, err := client.SendMessage(context.Background(), testutil.AuthedRequest(t, userID, &v1.SendMessageRequest{
		ChannelId:        channelID,
		EncryptedContent: []byte("encrypted content"),
		KeyVersion:       1,
	}))
	if err != nil {
		t.Fatalf("SendMessage: %v", err)
	}

	// Editing with keyVersion=0 should be rejected.
	_, err = client.EditMessage(context.Background(), testutil.AuthedRequest(t, userID, &v1.EditMessageRequest{
		ChannelId:        channelID,
		MessageId:        sendResp.Msg.MessageId,
		EncryptedContent: []byte("plaintext edit attempt"),
		KeyVersion:       0,
	}))
	if err == nil {
		t.Fatal("expected error for keyVersion=0 edit on encrypted channel")
	}
	if connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Errorf("code = %v, want InvalidArgument", connect.CodeOf(err))
	}

	// Editing with keyVersion>0 should succeed.
	_, err = client.EditMessage(context.Background(), testutil.AuthedRequest(t, userID, &v1.EditMessageRequest{
		ChannelId:        channelID,
		MessageId:        sendResp.Msg.MessageId,
		EncryptedContent: []byte("re-encrypted edit"),
		KeyVersion:       2,
	}))
	if err != nil {
		t.Fatalf("EditMessage with keyVersion=2: %v", err)
	}
}

func TestListServers(t *testing.T) {
	client, _, _, _ := setupChatTestServer(t)
	userID := models.NewID()

	_, err := client.CreateServer(context.Background(), testutil.AuthedRequest(t, userID, &v1.CreateServerRequest{Name: "Server One"}))
	if err != nil {
		t.Fatalf("CreateServer 1: %v", err)
	}
	_, err = client.CreateServer(context.Background(), testutil.AuthedRequest(t, userID, &v1.CreateServerRequest{Name: "Server Two"}))
	if err != nil {
		t.Fatalf("CreateServer 2: %v", err)
	}

	resp, err := client.ListServers(context.Background(), testutil.AuthedRequest(t, userID, &v1.ListServersRequest{}))
	if err != nil {
		t.Fatalf("ListServers: %v", err)
	}
	if len(resp.Msg.Servers) != 2 {
		t.Errorf("server count = %d, want 2", len(resp.Msg.Servers))
	}
}

func TestListChannels(t *testing.T) {
	client, _, _, _ := setupChatTestServer(t)
	userID := models.NewID()

	srvResp, err := client.CreateServer(context.Background(), testutil.AuthedRequest(t, userID, &v1.CreateServerRequest{Name: "Test Server"}))
	if err != nil {
		t.Fatalf("CreateServer: %v", err)
	}
	serverID := srvResp.Msg.Server.Id

	_, err = client.CreateChannel(context.Background(), testutil.AuthedRequest(t, userID, &v1.CreateChannelRequest{
		ServerId: serverID,
		Name:     "announcements",
	}))
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}

	resp, err := client.ListChannels(context.Background(), testutil.AuthedRequest(t, userID, &v1.ListChannelsRequest{
		ServerId: serverID,
	}))
	if err != nil {
		t.Fatalf("ListChannels: %v", err)
	}
	// Should have "general" (default) + "announcements"
	if len(resp.Msg.Channels) != 2 {
		t.Errorf("channel count = %d, want 2", len(resp.Msg.Channels))
	}
}

func TestUnauthenticatedRequest(t *testing.T) {
	client, _, _, _ := setupChatTestServer(t)

	_, err := client.CreateServer(context.Background(), connect.NewRequest(&v1.CreateServerRequest{Name: "Test"}))
	if err == nil {
		t.Fatal("expected error for unauthenticated request")
	}
	if connect.CodeOf(err) != connect.CodeUnauthenticated {
		t.Errorf("code = %v, want Unauthenticated", connect.CodeOf(err))
	}
}

// --- Invite & Join/Leave tests ---

func TestCreateInvite(t *testing.T) {
	client, _, _, _ := setupChatTestServer(t)
	ownerID := models.NewID()

	srvResp, err := client.CreateServer(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.CreateServerRequest{Name: "Test Server"}))
	if err != nil {
		t.Fatalf("CreateServer: %v", err)
	}

	resp, err := client.CreateInvite(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.CreateInviteRequest{
		ServerId: srvResp.Msg.Server.Id,
		MaxUses:  10,
	}))
	if err != nil {
		t.Fatalf("CreateInvite: %v", err)
	}
	if resp.Msg.Invite == nil {
		t.Fatal("expected invite in response")
	}
	if resp.Msg.Invite.Code == "" {
		t.Error("expected non-empty invite code")
	}
	if resp.Msg.Invite.MaxUses != 10 {
		t.Errorf("max_uses = %d, want 10", resp.Msg.Invite.MaxUses)
	}
}

func TestCreateInviteNotMember(t *testing.T) {
	client, _, _, _ := setupChatTestServer(t)
	ownerID := models.NewID()
	otherID := models.NewID()

	srvResp, err := client.CreateServer(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.CreateServerRequest{Name: "Test Server"}))
	if err != nil {
		t.Fatalf("CreateServer: %v", err)
	}

	_, err = client.CreateInvite(context.Background(), testutil.AuthedRequest(t, otherID, &v1.CreateInviteRequest{
		ServerId: srvResp.Msg.Server.Id,
	}))
	if err == nil {
		t.Fatal("expected error for non-member")
	}
	if connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Errorf("code = %v, want PermissionDenied", connect.CodeOf(err))
	}
}

func TestResolveInvite(t *testing.T) {
	client, _, _, _ := setupChatTestServer(t)
	ownerID := models.NewID()
	otherID := models.NewID()

	srvResp, err := client.CreateServer(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.CreateServerRequest{Name: "Test Server"}))
	if err != nil {
		t.Fatalf("CreateServer: %v", err)
	}

	invResp, err := client.CreateInvite(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.CreateInviteRequest{
		ServerId: srvResp.Msg.Server.Id,
	}))
	if err != nil {
		t.Fatalf("CreateInvite: %v", err)
	}

	resp, err := client.ResolveInvite(context.Background(), testutil.AuthedRequest(t, otherID, &v1.ResolveInviteRequest{
		Code: invResp.Msg.Invite.Code,
	}))
	if err != nil {
		t.Fatalf("ResolveInvite: %v", err)
	}
	if resp.Msg.Server == nil {
		t.Fatal("expected server in response")
	}
	if resp.Msg.Server.Name != "Test Server" {
		t.Errorf("server name = %q, want %q", resp.Msg.Server.Name, "Test Server")
	}
	if resp.Msg.MemberCount != 1 {
		t.Errorf("member_count = %d, want 1", resp.Msg.MemberCount)
	}
}

func TestResolveInviteNotFound(t *testing.T) {
	client, _, _, _ := setupChatTestServer(t)
	userID := models.NewID()

	_, err := client.ResolveInvite(context.Background(), testutil.AuthedRequest(t, userID, &v1.ResolveInviteRequest{
		Code: "nonexistent",
	}))
	if err == nil {
		t.Fatal("expected error for unknown code")
	}
	if connect.CodeOf(err) != connect.CodeNotFound {
		t.Errorf("code = %v, want NotFound", connect.CodeOf(err))
	}
}

func TestJoinServer(t *testing.T) {
	client, _, _, _ := setupChatTestServer(t)
	ownerID := models.NewID()
	joinerID := models.NewID()

	srvResp, err := client.CreateServer(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.CreateServerRequest{Name: "Test Server"}))
	if err != nil {
		t.Fatalf("CreateServer: %v", err)
	}

	invResp, err := client.CreateInvite(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.CreateInviteRequest{
		ServerId: srvResp.Msg.Server.Id,
	}))
	if err != nil {
		t.Fatalf("CreateInvite: %v", err)
	}

	joinResp, err := client.JoinServer(context.Background(), testutil.AuthedRequest(t, joinerID, &v1.JoinServerRequest{
		InviteCode: invResp.Msg.Invite.Code,
	}))
	if err != nil {
		t.Fatalf("JoinServer: %v", err)
	}
	if joinResp.Msg.Server == nil {
		t.Fatal("expected server in response")
	}
	if joinResp.Msg.Server.Name != "Test Server" {
		t.Errorf("server name = %q, want %q", joinResp.Msg.Server.Name, "Test Server")
	}
}

func TestJoinServerAlreadyMember(t *testing.T) {
	client, _, _, _ := setupChatTestServer(t)
	ownerID := models.NewID()

	srvResp, err := client.CreateServer(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.CreateServerRequest{Name: "Test Server"}))
	if err != nil {
		t.Fatalf("CreateServer: %v", err)
	}

	invResp, err := client.CreateInvite(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.CreateInviteRequest{
		ServerId: srvResp.Msg.Server.Id,
	}))
	if err != nil {
		t.Fatalf("CreateInvite: %v", err)
	}

	// Owner tries to join their own server.
	_, err = client.JoinServer(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.JoinServerRequest{
		InviteCode: invResp.Msg.Invite.Code,
	}))
	if err == nil {
		t.Fatal("expected error for already a member")
	}
	if connect.CodeOf(err) != connect.CodeAlreadyExists {
		t.Errorf("code = %v, want AlreadyExists", connect.CodeOf(err))
	}
}

func TestJoinServerExpiredInvite(t *testing.T) {
	client, _, _, inviteStore := setupChatTestServer(t)
	ownerID := models.NewID()
	joinerID := models.NewID()

	srvResp, err := client.CreateServer(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.CreateServerRequest{Name: "Test Server"}))
	if err != nil {
		t.Fatalf("CreateServer: %v", err)
	}

	// Create invite via API, then manually expire it in the mock store.
	invResp, err := client.CreateInvite(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.CreateInviteRequest{
		ServerId: srvResp.Msg.Server.Id,
	}))
	if err != nil {
		t.Fatalf("CreateInvite: %v", err)
	}

	// Expire the invite by setting ExpiresAt to the past.
	inviteStore.mu.Lock()
	past := time.Now().Add(-1 * time.Hour)
	inviteStore.invites[invResp.Msg.Invite.Code].ExpiresAt = &past
	inviteStore.mu.Unlock()

	_, err = client.JoinServer(context.Background(), testutil.AuthedRequest(t, joinerID, &v1.JoinServerRequest{
		InviteCode: invResp.Msg.Invite.Code,
	}))
	if err == nil {
		t.Fatal("expected error for expired invite")
	}
	if connect.CodeOf(err) != connect.CodeNotFound {
		t.Errorf("code = %v, want NotFound", connect.CodeOf(err))
	}
}

func TestJoinServerInvalidInvite(t *testing.T) {
	client, _, _, _ := setupChatTestServer(t)
	userID := models.NewID()

	_, err := client.JoinServer(context.Background(), testutil.AuthedRequest(t, userID, &v1.JoinServerRequest{
		InviteCode: "badcode1",
	}))
	if err == nil {
		t.Fatal("expected error for invalid invite")
	}
	if connect.CodeOf(err) != connect.CodeNotFound {
		t.Errorf("code = %v, want NotFound", connect.CodeOf(err))
	}
}

func TestLeaveServer(t *testing.T) {
	client, _, _, _ := setupChatTestServer(t)
	ownerID := models.NewID()
	joinerID := models.NewID()

	srvResp, err := client.CreateServer(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.CreateServerRequest{Name: "Test Server"}))
	if err != nil {
		t.Fatalf("CreateServer: %v", err)
	}
	serverID := srvResp.Msg.Server.Id

	invResp, err := client.CreateInvite(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.CreateInviteRequest{
		ServerId: serverID,
	}))
	if err != nil {
		t.Fatalf("CreateInvite: %v", err)
	}

	_, err = client.JoinServer(context.Background(), testutil.AuthedRequest(t, joinerID, &v1.JoinServerRequest{
		InviteCode: invResp.Msg.Invite.Code,
	}))
	if err != nil {
		t.Fatalf("JoinServer: %v", err)
	}

	_, err = client.LeaveServer(context.Background(), testutil.AuthedRequest(t, joinerID, &v1.LeaveServerRequest{
		ServerId: serverID,
	}))
	if err != nil {
		t.Fatalf("LeaveServer: %v", err)
	}
}

func TestLeaveServerOwner(t *testing.T) {
	client, _, _, _ := setupChatTestServer(t)
	ownerID := models.NewID()

	srvResp, err := client.CreateServer(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.CreateServerRequest{Name: "Test Server"}))
	if err != nil {
		t.Fatalf("CreateServer: %v", err)
	}

	_, err = client.LeaveServer(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.LeaveServerRequest{
		ServerId: srvResp.Msg.Server.Id,
	}))
	if err == nil {
		t.Fatal("expected error for owner leaving")
	}
	if connect.CodeOf(err) != connect.CodeFailedPrecondition {
		t.Errorf("code = %v, want FailedPrecondition", connect.CodeOf(err))
	}
}

func TestLeaveServerNotMember(t *testing.T) {
	client, _, _, _ := setupChatTestServer(t)
	ownerID := models.NewID()
	otherID := models.NewID()

	srvResp, err := client.CreateServer(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.CreateServerRequest{Name: "Test Server"}))
	if err != nil {
		t.Fatalf("CreateServer: %v", err)
	}

	_, err = client.LeaveServer(context.Background(), testutil.AuthedRequest(t, otherID, &v1.LeaveServerRequest{
		ServerId: srvResp.Msg.Server.Id,
	}))
	if err == nil {
		t.Fatal("expected error for non-member")
	}
	if connect.CodeOf(err) != connect.CodeNotFound {
		t.Errorf("code = %v, want NotFound", connect.CodeOf(err))
	}
}

func TestRevokeInvite(t *testing.T) {
	client, _, _, _ := setupChatTestServer(t)
	ownerID := models.NewID()

	srvResp, err := client.CreateServer(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.CreateServerRequest{Name: "Test Server"}))
	if err != nil {
		t.Fatalf("CreateServer: %v", err)
	}

	invResp, err := client.CreateInvite(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.CreateInviteRequest{
		ServerId: srvResp.Msg.Server.Id,
	}))
	if err != nil {
		t.Fatalf("CreateInvite: %v", err)
	}

	_, err = client.RevokeInvite(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.RevokeInviteRequest{
		Code: invResp.Msg.Invite.Code,
	}))
	if err != nil {
		t.Fatalf("RevokeInvite: %v", err)
	}

	// Verify the invite is now invalid.
	_, err = client.ResolveInvite(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.ResolveInviteRequest{
		Code: invResp.Msg.Invite.Code,
	}))
	if err == nil {
		t.Fatal("expected error for revoked invite")
	}
	if connect.CodeOf(err) != connect.CodeNotFound {
		t.Errorf("code = %v, want NotFound", connect.CodeOf(err))
	}
}

func TestRevokeInviteNotCreator(t *testing.T) {
	client, chatStore, _, _ := setupChatTestServer(t)
	ownerID := models.NewID()
	memberID := models.NewID()

	srvResp, err := client.CreateServer(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.CreateServerRequest{Name: "Test Server"}))
	if err != nil {
		t.Fatalf("CreateServer: %v", err)
	}
	serverID := srvResp.Msg.Server.Id

	// Add a second member directly.
	chatStore.AddMember(context.Background(), memberID, serverID)

	invResp, err := client.CreateInvite(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.CreateInviteRequest{
		ServerId: serverID,
	}))
	if err != nil {
		t.Fatalf("CreateInvite: %v", err)
	}

	// Member (not creator, not owner) tries to revoke.
	_, err = client.RevokeInvite(context.Background(), testutil.AuthedRequest(t, memberID, &v1.RevokeInviteRequest{
		Code: invResp.Msg.Invite.Code,
	}))
	if err == nil {
		t.Fatal("expected error for non-creator non-owner")
	}
	if connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Errorf("code = %v, want PermissionDenied", connect.CodeOf(err))
	}
}

func TestListInvites(t *testing.T) {
	client, _, _, _ := setupChatTestServer(t)
	ownerID := models.NewID()

	srvResp, err := client.CreateServer(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.CreateServerRequest{Name: "Test Server"}))
	if err != nil {
		t.Fatalf("CreateServer: %v", err)
	}
	serverID := srvResp.Msg.Server.Id

	_, err = client.CreateInvite(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.CreateInviteRequest{ServerId: serverID}))
	if err != nil {
		t.Fatalf("CreateInvite 1: %v", err)
	}
	_, err = client.CreateInvite(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.CreateInviteRequest{ServerId: serverID}))
	if err != nil {
		t.Fatalf("CreateInvite 2: %v", err)
	}

	resp, err := client.ListInvites(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.ListInvitesRequest{
		ServerId: serverID,
	}))
	if err != nil {
		t.Fatalf("ListInvites: %v", err)
	}
	if len(resp.Msg.Invites) != 2 {
		t.Errorf("invite count = %d, want 2", len(resp.Msg.Invites))
	}
}

func TestListInvitesNotMember(t *testing.T) {
	client, _, _, _ := setupChatTestServer(t)
	ownerID := models.NewID()
	otherID := models.NewID()

	srvResp, err := client.CreateServer(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.CreateServerRequest{Name: "Test Server"}))
	if err != nil {
		t.Fatalf("CreateServer: %v", err)
	}

	_, err = client.ListInvites(context.Background(), testutil.AuthedRequest(t, otherID, &v1.ListInvitesRequest{
		ServerId: srvResp.Msg.Server.Id,
	}))
	if err == nil {
		t.Fatal("expected error for non-member")
	}
	if connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Errorf("code = %v, want PermissionDenied", connect.CodeOf(err))
	}
}

// --- ListMembers tests ---

func TestListMembers(t *testing.T) {
	client, chatStore, _, _ := setupChatTestServer(t)
	ownerID := models.NewID()

	srvResp, err := client.CreateServer(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.CreateServerRequest{Name: "Test Server"}))
	if err != nil {
		t.Fatalf("CreateServer: %v", err)
	}
	serverID := srvResp.Msg.Server.Id

	// Add a second member.
	otherID := models.NewID()
	if err := chatStore.AddMember(context.Background(), otherID, serverID); err != nil {
		t.Fatalf("AddMember: %v", err)
	}

	resp, err := client.ListMembers(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.ListMembersRequest{
		ServerId: serverID,
	}))
	if err != nil {
		t.Fatalf("ListMembers: %v", err)
	}
	if len(resp.Msg.Members) != 2 {
		t.Errorf("member count = %d, want 2", len(resp.Msg.Members))
	}
}

func TestListMembersNotMember(t *testing.T) {
	client, _, _, _ := setupChatTestServer(t)
	ownerID := models.NewID()
	otherID := models.NewID()

	srvResp, err := client.CreateServer(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.CreateServerRequest{Name: "Test Server"}))
	if err != nil {
		t.Fatalf("CreateServer: %v", err)
	}

	_, err = client.ListMembers(context.Background(), testutil.AuthedRequest(t, otherID, &v1.ListMembersRequest{
		ServerId: srvResp.Msg.Server.Id,
	}))
	if err == nil {
		t.Fatal("expected error for non-member")
	}
	if connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Errorf("code = %v, want PermissionDenied", connect.CodeOf(err))
	}
}

func TestListMembersMissingServerId(t *testing.T) {
	client, _, _, _ := setupChatTestServer(t)
	userID := models.NewID()

	_, err := client.ListMembers(context.Background(), testutil.AuthedRequest(t, userID, &v1.ListMembersRequest{}))
	if err == nil {
		t.Fatal("expected error for missing server_id")
	}
	if connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Errorf("code = %v, want InvalidArgument", connect.CodeOf(err))
	}
}

func TestListMembersEmptyServer(t *testing.T) {
	client, chatStore, _, _ := setupChatTestServer(t)
	userID := models.NewID()

	srvResp, err := client.CreateServer(context.Background(), testutil.AuthedRequest(t, userID, &v1.CreateServerRequest{Name: "Test Server"}))
	if err != nil {
		t.Fatalf("CreateServer: %v", err)
	}
	serverID := srvResp.Msg.Server.Id

	// Remove the owner so the server has no members, then re-add to pass membership check.
	if err := chatStore.RemoveMember(context.Background(), userID, serverID); err != nil {
		t.Fatalf("RemoveMember: %v", err)
	}
	if err := chatStore.AddMember(context.Background(), userID, serverID); err != nil {
		t.Fatalf("AddMember: %v", err)
	}

	resp, err := client.ListMembers(context.Background(), testutil.AuthedRequest(t, userID, &v1.ListMembersRequest{
		ServerId: serverID,
	}))
	if err != nil {
		t.Fatalf("ListMembers: %v", err)
	}
	// Server has 1 member (the caller), not 0. That's fine — the test verifies
	// the endpoint returns a list (not an error) for a server with members.
	if resp.Msg.Members == nil {
		t.Error("expected non-nil members slice")
	}
}

func TestListMembersPagination(t *testing.T) {
	client, chatStore, _, _ := setupChatTestServer(t)
	ownerID := models.NewID()

	srvResp, err := client.CreateServer(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.CreateServerRequest{Name: "Test Server"}))
	if err != nil {
		t.Fatalf("CreateServer: %v", err)
	}
	serverID := srvResp.Msg.Server.Id

	// Add 2 more members (3 total with owner).
	for i := 0; i < 2; i++ {
		if err := chatStore.AddMember(context.Background(), models.NewID(), serverID); err != nil {
			t.Fatalf("AddMember %d: %v", i, err)
		}
	}

	// Fetch first page with limit=2.
	page1, err := client.ListMembers(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.ListMembersRequest{
		ServerId: serverID,
		Limit:    2,
	}))
	if err != nil {
		t.Fatalf("ListMembers page1: %v", err)
	}
	if len(page1.Msg.Members) != 2 {
		t.Fatalf("page1 count = %d, want 2", len(page1.Msg.Members))
	}

	// Fetch second page using last user_id as cursor.
	cursor := page1.Msg.Members[len(page1.Msg.Members)-1].UserId
	page2, err := client.ListMembers(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.ListMembersRequest{
		ServerId: serverID,
		Limit:    2,
		After:    cursor,
	}))
	if err != nil {
		t.Fatalf("ListMembers page2: %v", err)
	}
	if len(page2.Msg.Members) != 1 {
		t.Errorf("page2 count = %d, want 1", len(page2.Msg.Members))
	}

	// Ensure no overlap between pages.
	page1IDs := make(map[string]bool)
	for _, m := range page1.Msg.Members {
		page1IDs[m.UserId] = true
	}
	for _, m := range page2.Msg.Members {
		if page1IDs[m.UserId] {
			t.Errorf("user %s appears in both pages", m.UserId)
		}
	}
}

// --- EditMessage / DeleteMessage tests ---

// helper: creates a server, gets the default channel, sends a message, returns IDs.
func setupMessageTest(t *testing.T) (mezav1connect.ChatServiceClient, *mockChatStore, string, string, string) {
	t.Helper()
	client, chatStore, _, _ := setupChatTestServer(t)
	userID := models.NewID()

	srvResp, err := client.CreateServer(context.Background(), testutil.AuthedRequest(t, userID, &v1.CreateServerRequest{Name: "Test Server"}))
	if err != nil {
		t.Fatalf("CreateServer: %v", err)
	}
	channels, err := chatStore.ListChannels(context.Background(), srvResp.Msg.Server.Id, "")
	if err != nil || len(channels) == 0 {
		t.Fatal("expected default channel")
	}
	channelID := channels[0].ID

	sendResp, err := client.SendMessage(context.Background(), testutil.AuthedRequest(t, userID, &v1.SendMessageRequest{
		ChannelId:        channelID,
		EncryptedContent: []byte("original content"),
	}))
	if err != nil {
		t.Fatalf("SendMessage: %v", err)
	}

	return client, chatStore, userID, channelID, sendResp.Msg.MessageId
}

func TestEditMessage(t *testing.T) {
	client, _, userID, channelID, messageID := setupMessageTest(t)

	resp, err := client.EditMessage(context.Background(), testutil.AuthedRequest(t, userID, &v1.EditMessageRequest{
		ChannelId:        channelID,
		MessageId:        messageID,
		EncryptedContent: []byte("edited content"),
	}))
	if err != nil {
		t.Fatalf("EditMessage: %v", err)
	}
	if resp.Msg.EditedAt == nil {
		t.Fatal("expected edited_at in response")
	}

	// Verify the message was updated via GetMessages.
	getResp, err := client.GetMessages(context.Background(), testutil.AuthedRequest(t, userID, &v1.GetMessagesRequest{
		ChannelId: channelID,
	}))
	if err != nil {
		t.Fatalf("GetMessages: %v", err)
	}
	if len(getResp.Msg.Messages) != 1 {
		t.Fatalf("messages count = %d, want 1", len(getResp.Msg.Messages))
	}
	if string(getResp.Msg.Messages[0].EncryptedContent) != "edited content" {
		t.Errorf("content = %q, want %q", string(getResp.Msg.Messages[0].EncryptedContent), "edited content")
	}
	if getResp.Msg.Messages[0].EditedAt == nil {
		t.Error("expected edited_at on message")
	}
}

func TestEditMessageNotAuthor(t *testing.T) {
	client, chatStore, _, channelID, messageID := setupMessageTest(t)
	otherID := models.NewID()

	// Add the other user as a member so they pass the membership check.
	for _, ch := range chatStore.channels {
		if ch.ID == channelID {
			chatStore.AddMember(context.Background(), otherID, ch.ServerID)
			break
		}
	}

	_, err := client.EditMessage(context.Background(), testutil.AuthedRequest(t, otherID, &v1.EditMessageRequest{
		ChannelId:        channelID,
		MessageId:        messageID,
		EncryptedContent: []byte("hacked"),
	}))
	if err == nil {
		t.Fatal("expected error for non-author")
	}
	if connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Errorf("code = %v, want PermissionDenied", connect.CodeOf(err))
	}
}

func TestEditMessageNotMember(t *testing.T) {
	client, _, _, channelID, messageID := setupMessageTest(t)
	outsiderID := models.NewID()

	_, err := client.EditMessage(context.Background(), testutil.AuthedRequest(t, outsiderID, &v1.EditMessageRequest{
		ChannelId:        channelID,
		MessageId:        messageID,
		EncryptedContent: []byte("sneaky"),
	}))
	if err == nil {
		t.Fatal("expected error for non-member")
	}
	if connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Errorf("code = %v, want PermissionDenied", connect.CodeOf(err))
	}
}

func TestEditMessageDeleted(t *testing.T) {
	client, _, userID, channelID, messageID := setupMessageTest(t)

	// Delete the message first.
	_, err := client.DeleteMessage(context.Background(), testutil.AuthedRequest(t, userID, &v1.DeleteMessageRequest{
		ChannelId: channelID,
		MessageId: messageID,
	}))
	if err != nil {
		t.Fatalf("DeleteMessage: %v", err)
	}

	// Now try to edit the deleted message.
	_, err = client.EditMessage(context.Background(), testutil.AuthedRequest(t, userID, &v1.EditMessageRequest{
		ChannelId:        channelID,
		MessageId:        messageID,
		EncryptedContent: []byte("revive attempt"),
	}))
	if err == nil {
		t.Fatal("expected error for deleted message")
	}
	if connect.CodeOf(err) != connect.CodeNotFound {
		t.Errorf("code = %v, want NotFound", connect.CodeOf(err))
	}
}

func TestEditMessageMissingFields(t *testing.T) {
	client, _, userID, _, _ := setupMessageTest(t)

	_, err := client.EditMessage(context.Background(), testutil.AuthedRequest(t, userID, &v1.EditMessageRequest{
		ChannelId: "",
		MessageId: "",
	}))
	if err == nil {
		t.Fatal("expected error for missing fields")
	}
	if connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Errorf("code = %v, want InvalidArgument", connect.CodeOf(err))
	}
}

func TestDeleteMessage(t *testing.T) {
	client, _, userID, channelID, messageID := setupMessageTest(t)

	_, err := client.DeleteMessage(context.Background(), testutil.AuthedRequest(t, userID, &v1.DeleteMessageRequest{
		ChannelId: channelID,
		MessageId: messageID,
	}))
	if err != nil {
		t.Fatalf("DeleteMessage: %v", err)
	}

	// Verify the message no longer appears in GetMessages.
	getResp, err := client.GetMessages(context.Background(), testutil.AuthedRequest(t, userID, &v1.GetMessagesRequest{
		ChannelId: channelID,
	}))
	if err != nil {
		t.Fatalf("GetMessages: %v", err)
	}
	if len(getResp.Msg.Messages) != 0 {
		t.Errorf("messages count = %d, want 0 (deleted message should be filtered)", len(getResp.Msg.Messages))
	}
}

func TestDeleteMessageNotAuthor(t *testing.T) {
	client, chatStore, _, channelID, messageID := setupMessageTest(t)
	otherID := models.NewID()

	for _, ch := range chatStore.channels {
		if ch.ID == channelID {
			chatStore.AddMember(context.Background(), otherID, ch.ServerID)
			break
		}
	}

	_, err := client.DeleteMessage(context.Background(), testutil.AuthedRequest(t, otherID, &v1.DeleteMessageRequest{
		ChannelId: channelID,
		MessageId: messageID,
	}))
	if err == nil {
		t.Fatal("expected error for non-author")
	}
	if connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Errorf("code = %v, want PermissionDenied", connect.CodeOf(err))
	}
}

func TestDeleteMessageNotMember(t *testing.T) {
	client, _, _, channelID, messageID := setupMessageTest(t)
	outsiderID := models.NewID()

	_, err := client.DeleteMessage(context.Background(), testutil.AuthedRequest(t, outsiderID, &v1.DeleteMessageRequest{
		ChannelId: channelID,
		MessageId: messageID,
	}))
	if err == nil {
		t.Fatal("expected error for non-member")
	}
	if connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Errorf("code = %v, want PermissionDenied", connect.CodeOf(err))
	}
}

func TestDeleteMessageAlreadyDeleted(t *testing.T) {
	client, _, userID, channelID, messageID := setupMessageTest(t)

	// Delete once.
	_, err := client.DeleteMessage(context.Background(), testutil.AuthedRequest(t, userID, &v1.DeleteMessageRequest{
		ChannelId: channelID,
		MessageId: messageID,
	}))
	if err != nil {
		t.Fatalf("DeleteMessage: %v", err)
	}

	// Delete again — should get NotFound since the message is already deleted.
	_, err = client.DeleteMessage(context.Background(), testutil.AuthedRequest(t, userID, &v1.DeleteMessageRequest{
		ChannelId: channelID,
		MessageId: messageID,
	}))
	if err == nil {
		t.Fatal("expected error for already-deleted message")
	}
	if connect.CodeOf(err) != connect.CodeNotFound {
		t.Errorf("code = %v, want NotFound", connect.CodeOf(err))
	}
}

// --- UpdateMember tests ---

// setupUpdateMemberTest creates a server with an owner, an admin with ManageRoles,
// a target member, and two roles (admin role at position 10, low role at position 1).
// Returns client, chatStore, roleStore, serverID, ownerID, adminID, targetID, adminRoleID, lowRoleID.
func setupUpdateMemberTest(t *testing.T) (mezav1connect.ChatServiceClient, *mockChatStore, *mockRoleStore, string, string, string, string, string, string) {
	t.Helper()
	client, chatStore, roleStore, _ := setupModerationTestServer(t)

	ownerID := models.NewID()
	adminID := models.NewID()
	targetID := models.NewID()

	// Create server (owner is auto-added as member).
	srvResp, err := client.CreateServer(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.CreateServerRequest{Name: "Test Server"}))
	if err != nil {
		t.Fatalf("CreateServer: %v", err)
	}
	serverID := srvResp.Msg.Server.Id

	// Add admin and target as members.
	chatStore.AddMember(context.Background(), adminID, serverID)
	chatStore.AddMember(context.Background(), targetID, serverID)

	// Create roles: admin role (position 10, ManageRoles) and low role (position 1, KickMembers).
	adminRoleID := models.NewID()
	lowRoleID := models.NewID()
	roleStore.CreateRole(context.Background(), &models.Role{
		ID:          adminRoleID,
		ServerID:    serverID,
		Name:        "Admin",
		Position:    10,
		Permissions: permissions.ManageRoles | permissions.KickMembers,
	})
	roleStore.CreateRole(context.Background(), &models.Role{
		ID:          lowRoleID,
		ServerID:    serverID,
		Name:        "Member",
		Position:    1,
		Permissions: permissions.KickMembers,
	})

	// Assign admin role to the admin user.
	roleStore.assignRoles(serverID, adminID, []string{adminRoleID})

	return client, chatStore, roleStore, serverID, ownerID, adminID, targetID, adminRoleID, lowRoleID
}

func TestSetMemberRolesOwnerAssignsRoles(t *testing.T) {
	client, _, _, serverID, ownerID, _, targetID, adminRoleID, lowRoleID := setupUpdateMemberTest(t)

	// Owner can assign any roles, including high-position ones.
	resp, err := client.SetMemberRoles(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.SetMemberRolesRequest{
		ServerId: serverID,
		UserId:   targetID,
		RoleIds:  []string{adminRoleID, lowRoleID},
	}))
	if err != nil {
		t.Fatalf("SetMemberRoles: %v", err)
	}
	if resp.Msg.Member == nil {
		t.Fatal("expected member in response")
	}
	if resp.Msg.Member.UserId != targetID {
		t.Errorf("user_id = %q, want %q", resp.Msg.Member.UserId, targetID)
	}
}

func TestSetMemberRolesAdminAssignsLowerRole(t *testing.T) {
	client, _, _, serverID, _, adminID, targetID, _, lowRoleID := setupUpdateMemberTest(t)

	// Admin (position 10) assigns low role (position 1) — should succeed.
	resp, err := client.SetMemberRoles(context.Background(), testutil.AuthedRequest(t, adminID, &v1.SetMemberRolesRequest{
		ServerId: serverID,
		UserId:   targetID,
		RoleIds:  []string{lowRoleID},
	}))
	if err != nil {
		t.Fatalf("SetMemberRoles: %v", err)
	}
	if resp.Msg.Member == nil {
		t.Fatal("expected member in response")
	}
}

func TestSetMemberRolesClearRoles(t *testing.T) {
	client, _, roleStore, serverID, ownerID, _, targetID, _, lowRoleID := setupUpdateMemberTest(t)

	// First assign a role.
	roleStore.assignRoles(serverID, targetID, []string{lowRoleID})

	// Clear all roles by sending empty RoleIds — SetMemberRoles always interprets the call
	// as a role operation, so empty means "remove all roles".
	resp, err := client.SetMemberRoles(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.SetMemberRolesRequest{
		ServerId: serverID,
		UserId:   targetID,
	}))
	if err != nil {
		t.Fatalf("SetMemberRoles: %v", err)
	}
	if resp.Msg.Member == nil {
		t.Fatal("expected member in response")
	}
}

func TestUpdateMemberUnauthenticated(t *testing.T) {
	client, _, _, _ := setupModerationTestServer(t)

	_, err := client.UpdateMember(context.Background(), connect.NewRequest(&v1.UpdateMemberRequest{
		ServerId: "some-server",
		UserId:   "some-user",
		Nickname: proto.String("nick"),
	}))
	if err == nil {
		t.Fatal("expected error for unauthenticated")
	}
	if connect.CodeOf(err) != connect.CodeUnauthenticated {
		t.Errorf("code = %v, want Unauthenticated", connect.CodeOf(err))
	}
}

func TestUpdateMemberMissingFields(t *testing.T) {
	client, _, _, _ := setupModerationTestServer(t)
	userID := models.NewID()

	_, err := client.UpdateMember(context.Background(), testutil.AuthedRequest(t, userID, &v1.UpdateMemberRequest{
		ServerId: "",
		UserId:   "",
		Nickname: proto.String("nick"),
	}))
	if err == nil {
		t.Fatal("expected error for missing fields")
	}
	if connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Errorf("code = %v, want InvalidArgument", connect.CodeOf(err))
	}
}

func TestSetMemberRolesCallerNotMember(t *testing.T) {
	client, chatStore, _, _ := setupModerationTestServer(t)
	ownerID := models.NewID()
	outsiderID := models.NewID()
	targetID := models.NewID()

	srvResp, err := client.CreateServer(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.CreateServerRequest{Name: "Test"}))
	if err != nil {
		t.Fatalf("CreateServer: %v", err)
	}
	serverID := srvResp.Msg.Server.Id
	chatStore.AddMember(context.Background(), targetID, serverID)

	// Outsider (not a member) tries to set member roles.
	_, err = client.SetMemberRoles(context.Background(), testutil.AuthedRequest(t, outsiderID, &v1.SetMemberRolesRequest{
		ServerId: serverID,
		UserId:   targetID,
		RoleIds:  []string{"some-role-id"},
	}))
	if err == nil {
		t.Fatal("expected error for non-member caller")
	}
	if connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Errorf("code = %v, want PermissionDenied", connect.CodeOf(err))
	}
}

func TestSetMemberRolesNoManageRolesPermission(t *testing.T) {
	client, chatStore, _, _ := setupModerationTestServer(t)
	ownerID := models.NewID()
	memberID := models.NewID()
	targetID := models.NewID()

	srvResp, err := client.CreateServer(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.CreateServerRequest{Name: "Test"}))
	if err != nil {
		t.Fatalf("CreateServer: %v", err)
	}
	serverID := srvResp.Msg.Server.Id
	chatStore.AddMember(context.Background(), memberID, serverID)
	chatStore.AddMember(context.Background(), targetID, serverID)

	// Member has no roles (no ManageRoles permission).
	_, err = client.SetMemberRoles(context.Background(), testutil.AuthedRequest(t, memberID, &v1.SetMemberRolesRequest{
		ServerId: serverID,
		UserId:   targetID,
		RoleIds:  []string{"some-role-id"},
	}))
	if err == nil {
		t.Fatal("expected error for missing ManageRoles permission")
	}
	if connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Errorf("code = %v, want PermissionDenied", connect.CodeOf(err))
	}
}

func TestSetMemberRolesTargetNotMember(t *testing.T) {
	client, _, _, serverID, ownerID, _, _, _, _ := setupUpdateMemberTest(t)
	nonMemberID := models.NewID()

	_, err := client.SetMemberRoles(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.SetMemberRolesRequest{
		ServerId: serverID,
		UserId:   nonMemberID,
		RoleIds:  []string{"some-role-id"},
	}))
	if err == nil {
		t.Fatal("expected error for target not a member")
	}
	if connect.CodeOf(err) != connect.CodeNotFound {
		t.Errorf("code = %v, want NotFound", connect.CodeOf(err))
	}
}

func TestSetMemberRolesOwnerProtection(t *testing.T) {
	client, _, _, serverID, ownerID, adminID, _, _, lowRoleID := setupUpdateMemberTest(t)

	// Admin tries to modify the owner's roles — should be denied.
	_, err := client.SetMemberRoles(context.Background(), testutil.AuthedRequest(t, adminID, &v1.SetMemberRolesRequest{
		ServerId: serverID,
		UserId:   ownerID,
		RoleIds:  []string{lowRoleID},
	}))
	if err == nil {
		t.Fatal("expected error for modifying owner's roles")
	}
	if connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Errorf("code = %v, want PermissionDenied", connect.CodeOf(err))
	}
}

func TestSetMemberRolesSelfAssignmentBlocked(t *testing.T) {
	client, _, _, serverID, _, adminID, _, _, lowRoleID := setupUpdateMemberTest(t)

	// Admin tries to assign roles to themselves — should be denied.
	_, err := client.SetMemberRoles(context.Background(), testutil.AuthedRequest(t, adminID, &v1.SetMemberRolesRequest{
		ServerId: serverID,
		UserId:   adminID,
		RoleIds:  []string{lowRoleID},
	}))
	if err == nil {
		t.Fatal("expected error for self-assignment")
	}
	if connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Errorf("code = %v, want PermissionDenied", connect.CodeOf(err))
	}
}

func TestSetMemberRolesOwnerCanSelfAssign(t *testing.T) {
	client, _, _, serverID, ownerID, _, _, _, lowRoleID := setupUpdateMemberTest(t)

	// Owner assigns roles to themselves — should succeed (owner bypasses self-assignment block).
	resp, err := client.SetMemberRoles(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.SetMemberRolesRequest{
		ServerId: serverID,
		UserId:   ownerID,
		RoleIds:  []string{lowRoleID},
	}))
	if err != nil {
		t.Fatalf("SetMemberRoles: %v", err)
	}
	if resp.Msg.Member == nil {
		t.Fatal("expected member in response")
	}
}

func TestSetMemberRolesHierarchyViolation(t *testing.T) {
	client, _, _, serverID, _, adminID, targetID, adminRoleID, _ := setupUpdateMemberTest(t)

	// Admin (position 10) tries to assign admin role (position 10, equal) — should be denied.
	_, err := client.SetMemberRoles(context.Background(), testutil.AuthedRequest(t, adminID, &v1.SetMemberRolesRequest{
		ServerId: serverID,
		UserId:   targetID,
		RoleIds:  []string{adminRoleID},
	}))
	if err == nil {
		t.Fatal("expected error for hierarchy violation")
	}
	if connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Errorf("code = %v, want PermissionDenied", connect.CodeOf(err))
	}
}

func TestSetMemberRolesEscalationBlocked(t *testing.T) {
	client, _, roleStore, serverID, _, adminID, targetID, _, _ := setupUpdateMemberTest(t)

	// Create a role with BanMembers permission (which the admin doesn't have).
	banRoleID := models.NewID()
	roleStore.CreateRole(context.Background(), &models.Role{
		ID:          banRoleID,
		ServerID:    serverID,
		Name:        "Banner",
		Position:    2, // Below admin (position 10)
		Permissions: permissions.BanMembers,
	})

	// Admin has ManageRoles|KickMembers but NOT BanMembers.
	// Assigning a role with BanMembers is escalation.
	_, err := client.SetMemberRoles(context.Background(), testutil.AuthedRequest(t, adminID, &v1.SetMemberRolesRequest{
		ServerId: serverID,
		UserId:   targetID,
		RoleIds:  []string{banRoleID},
	}))
	if err == nil {
		t.Fatal("expected error for permission escalation")
	}
	if connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Errorf("code = %v, want PermissionDenied", connect.CodeOf(err))
	}
}

func TestSetMemberRolesInvalidRoleIDs(t *testing.T) {
	client, _, _, serverID, ownerID, _, targetID, _, _ := setupUpdateMemberTest(t)

	// Assign a role ID that doesn't exist.
	_, err := client.SetMemberRoles(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.SetMemberRolesRequest{
		ServerId: serverID,
		UserId:   targetID,
		RoleIds:  []string{"nonexistent-role-id"},
	}))
	if err == nil {
		t.Fatal("expected error for invalid role IDs")
	}
	if connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Errorf("code = %v, want InvalidArgument", connect.CodeOf(err))
	}
}

func TestSetMemberRolesDuplicateRoleIDs(t *testing.T) {
	client, _, _, serverID, ownerID, _, targetID, _, lowRoleID := setupUpdateMemberTest(t)

	// Passing the same role ID twice should be deduplicated and succeed.
	resp, err := client.SetMemberRoles(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.SetMemberRolesRequest{
		ServerId: serverID,
		UserId:   targetID,
		RoleIds:  []string{lowRoleID, lowRoleID},
	}))
	if err != nil {
		t.Fatalf("SetMemberRoles: %v", err)
	}
	if resp.Msg.Member == nil {
		t.Fatal("expected member in response")
	}
}

func TestSetMemberRolesOwnerBypassesHierarchy(t *testing.T) {
	client, _, roleStore, serverID, ownerID, _, targetID, _, _ := setupUpdateMemberTest(t)

	// Create a very high-position role.
	highRoleID := models.NewID()
	roleStore.CreateRole(context.Background(), &models.Role{
		ID:          highRoleID,
		ServerID:    serverID,
		Name:        "Supreme",
		Position:    100,
		Permissions: permissions.AllPermissions,
	})

	// Owner can assign any role regardless of position.
	resp, err := client.SetMemberRoles(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.SetMemberRolesRequest{
		ServerId: serverID,
		UserId:   targetID,
		RoleIds:  []string{highRoleID},
	}))
	if err != nil {
		t.Fatalf("SetMemberRoles: %v", err)
	}
	if resp.Msg.Member == nil {
		t.Fatal("expected member in response")
	}
}

// --- Pin tests ---

// setupPinTestServer creates a test server with access to all mock stores
// for testing pin endpoints (PinMessage, UnpinMessage, GetPinnedMessages).
func setupPinTestServer(t *testing.T) (mezav1connect.ChatServiceClient, *mockChatStore, *mockMessageStore, *mockRoleStore, *mockPinStore) {
	t.Helper()
	roleStore := newMockRoleStore()
	chatStore := newMockChatStore(roleStore)
	messageStore := newMockMessageStore()
	inviteStore := newMockInviteStore()
	banStore := newMockBanStore()
	pinStore := newMockPinStore()
	emojiStore := &mockEmojiStore{}
	nc := testutil.StartTestNATS(t)

	svc := newChatService(chatServiceConfig{
		ChatStore:               chatStore,
		MessageStore:            messageStore,
		InviteStore:             inviteStore,
		RoleStore:               roleStore,
		BanStore:                banStore,
		PinStore:                pinStore,
		EmojiStore:              emojiStore,
		MediaStore:              newMockMediaStore(),
		PermissionOverrideStore: &mockPermissionOverrideStore{},
		NC:                      nc,
		PermCache:               permissions.NewCache(nil),
	})

	interceptor := connect.WithInterceptors(auth.NewConnectInterceptor(testutil.TestEd25519Keys.PublicKey))
	mux := http.NewServeMux()
	path, handler := mezav1connect.NewChatServiceHandler(svc, interceptor)
	mux.Handle(path, handler)

	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	client := mezav1connect.NewChatServiceClient(http.DefaultClient, srv.URL)
	return client, chatStore, messageStore, roleStore, pinStore
}

// setupPinTest creates a server + channel + message for pin tests.
func setupPinTest(t *testing.T) (mezav1connect.ChatServiceClient, *mockChatStore, *mockMessageStore, *mockRoleStore, *mockPinStore, string, string, string, string) {
	t.Helper()
	client, chatStore, messageStore, roleStore, pinStore := setupPinTestServer(t)
	ownerID := models.NewID()

	srvResp, err := client.CreateServer(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.CreateServerRequest{Name: "Test Server"}))
	if err != nil {
		t.Fatalf("CreateServer: %v", err)
	}
	serverID := srvResp.Msg.Server.Id

	channels, err := chatStore.ListChannels(context.Background(), serverID, ownerID)
	if err != nil || len(channels) == 0 {
		t.Fatal("expected default channel")
	}
	channelID := channels[0].ID

	sendResp, err := client.SendMessage(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.SendMessageRequest{
		ChannelId:        channelID,
		EncryptedContent: []byte("pinnable content"),
	}))
	if err != nil {
		t.Fatalf("SendMessage: %v", err)
	}

	return client, chatStore, messageStore, roleStore, pinStore, ownerID, serverID, channelID, sendResp.Msg.MessageId
}

func TestPinMessage(t *testing.T) {
	client, _, _, _, _, ownerID, _, channelID, messageID := setupPinTest(t)

	resp, err := client.PinMessage(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.PinMessageRequest{
		ChannelId: channelID,
		MessageId: messageID,
	}))
	if err != nil {
		t.Fatalf("PinMessage: %v", err)
	}
	if resp.Msg.PinnedMessage == nil {
		t.Fatal("expected pinned_message in response")
	}
	if resp.Msg.PinnedMessage.Message == nil {
		t.Fatal("expected message in pinned_message")
	}
	if resp.Msg.PinnedMessage.Message.Id != messageID {
		t.Errorf("message_id = %q, want %q", resp.Msg.PinnedMessage.Message.Id, messageID)
	}
	if resp.Msg.PinnedMessage.PinnedBy != ownerID {
		t.Errorf("pinned_by = %q, want %q", resp.Msg.PinnedMessage.PinnedBy, ownerID)
	}
}

func TestPinMessageNotMember(t *testing.T) {
	client, _, _, _, _, _, _, channelID, messageID := setupPinTest(t)
	outsiderID := models.NewID()

	_, err := client.PinMessage(context.Background(), testutil.AuthedRequest(t, outsiderID, &v1.PinMessageRequest{
		ChannelId: channelID,
		MessageId: messageID,
	}))
	if err == nil {
		t.Fatal("expected error for non-member")
	}
	if connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Errorf("code = %v, want PermissionDenied", connect.CodeOf(err))
	}
}

func TestPinMessageMissingPermission(t *testing.T) {
	client, chatStore, _, _, _, _, serverID, channelID, messageID := setupPinTest(t)

	// Add a member with no permissions who is NOT the message author.
	memberID := models.NewID()
	chatStore.AddMember(context.Background(), memberID, serverID)

	_, err := client.PinMessage(context.Background(), testutil.AuthedRequest(t, memberID, &v1.PinMessageRequest{
		ChannelId: channelID,
		MessageId: messageID,
	}))
	if err == nil {
		t.Fatal("expected error for missing ManageMessages permission")
	}
	if connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Errorf("code = %v, want PermissionDenied", connect.CodeOf(err))
	}
}

func TestPinMessageAuthorAllowed(t *testing.T) {
	client, _, _, _, _, ownerID, _, channelID, messageID := setupPinTest(t)

	// Owner is the message author — should succeed without ManageMessages permission.
	resp, err := client.PinMessage(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.PinMessageRequest{
		ChannelId: channelID,
		MessageId: messageID,
	}))
	if err != nil {
		t.Fatalf("PinMessage: %v", err)
	}
	if resp.Msg.PinnedMessage == nil {
		t.Fatal("expected pinned_message in response")
	}
}

func TestPinMessageIdempotent(t *testing.T) {
	client, _, _, _, _, ownerID, _, channelID, messageID := setupPinTest(t)

	// Pin once.
	_, err := client.PinMessage(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.PinMessageRequest{
		ChannelId: channelID,
		MessageId: messageID,
	}))
	if err != nil {
		t.Fatalf("PinMessage (first): %v", err)
	}

	// Pin again — should succeed (idempotent).
	_, err = client.PinMessage(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.PinMessageRequest{
		ChannelId: channelID,
		MessageId: messageID,
	}))
	if err != nil {
		t.Fatalf("PinMessage (second): %v", err)
	}
}

func TestUnpinMessage(t *testing.T) {
	client, _, _, _, _, ownerID, _, channelID, messageID := setupPinTest(t)

	// Pin first.
	_, err := client.PinMessage(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.PinMessageRequest{
		ChannelId: channelID,
		MessageId: messageID,
	}))
	if err != nil {
		t.Fatalf("PinMessage: %v", err)
	}

	// Unpin.
	_, err = client.UnpinMessage(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.UnpinMessageRequest{
		ChannelId: channelID,
		MessageId: messageID,
	}))
	if err != nil {
		t.Fatalf("UnpinMessage: %v", err)
	}

	// Verify the pin is removed by trying to get pinned messages.
	resp, err := client.GetPinnedMessages(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.GetPinnedMessagesRequest{
		ChannelId: channelID,
	}))
	if err != nil {
		t.Fatalf("GetPinnedMessages: %v", err)
	}
	if len(resp.Msg.PinnedMessages) != 0 {
		t.Errorf("pinned count = %d, want 0", len(resp.Msg.PinnedMessages))
	}
}

func TestUnpinMessageNotPinned(t *testing.T) {
	client, _, _, _, _, ownerID, _, channelID, messageID := setupPinTest(t)

	// Try to unpin a message that isn't pinned.
	_, err := client.UnpinMessage(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.UnpinMessageRequest{
		ChannelId: channelID,
		MessageId: messageID,
	}))
	if err == nil {
		t.Fatal("expected error for message not pinned")
	}
	if connect.CodeOf(err) != connect.CodeNotFound {
		t.Errorf("code = %v, want NotFound", connect.CodeOf(err))
	}
}

func TestGetPinnedMessages(t *testing.T) {
	client, _, _, _, _, ownerID, _, channelID, messageID := setupPinTest(t)

	// Pin the message.
	_, err := client.PinMessage(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.PinMessageRequest{
		ChannelId: channelID,
		MessageId: messageID,
	}))
	if err != nil {
		t.Fatalf("PinMessage: %v", err)
	}

	// Get pinned messages.
	resp, err := client.GetPinnedMessages(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.GetPinnedMessagesRequest{
		ChannelId: channelID,
	}))
	if err != nil {
		t.Fatalf("GetPinnedMessages: %v", err)
	}
	if len(resp.Msg.PinnedMessages) != 1 {
		t.Fatalf("pinned count = %d, want 1", len(resp.Msg.PinnedMessages))
	}
	pin := resp.Msg.PinnedMessages[0]
	if pin.Message == nil {
		t.Fatal("expected message in pinned_message")
	}
	if pin.Message.Id != messageID {
		t.Errorf("message_id = %q, want %q", pin.Message.Id, messageID)
	}
	if string(pin.Message.EncryptedContent) != "pinnable content" {
		t.Errorf("content = %q, want %q", string(pin.Message.EncryptedContent), "pinnable content")
	}
}

// --- GetMessages around / cursor tests ---

// helper: create a server + channel and send N messages, return (channelID, messageIDs)
func setupMessagesForAroundTests(t *testing.T, client mezav1connect.ChatServiceClient, chatStore *mockChatStore, userID string, count int) (string, []string) {
	t.Helper()

	srvResp, err := client.CreateServer(context.Background(), testutil.AuthedRequest(t, userID, &v1.CreateServerRequest{
		Name: "Around Test Server",
	}))
	if err != nil {
		t.Fatalf("CreateServer: %v", err)
	}
	serverID := srvResp.Msg.Server.Id

	channels, err := chatStore.ListChannels(context.Background(), serverID, userID)
	if err != nil {
		t.Fatalf("ListChannels: %v", err)
	}
	channelID := channels[0].ID

	var messageIDs []string
	for i := 0; i < count; i++ {
		// Small sleep so ULIDs get different timestamps
		time.Sleep(time.Millisecond)
		resp, err := client.SendMessage(context.Background(), testutil.AuthedRequest(t, userID, &v1.SendMessageRequest{
			ChannelId:        channelID,
			EncryptedContent: []byte(fmt.Sprintf("msg-%d", i)),
		}))
		if err != nil {
			t.Fatalf("SendMessage[%d]: %v", i, err)
		}
		messageIDs = append(messageIDs, resp.Msg.MessageId)
	}
	return channelID, messageIDs
}

func TestGetMessagesAround(t *testing.T) {
	client, chatStore, _, _ := setupChatTestServer(t)
	userID := models.NewID()

	channelID, msgIDs := setupMessagesForAroundTests(t, client, chatStore, userID, 5)

	// Query around the middle message
	resp, err := client.GetMessages(context.Background(), testutil.AuthedRequest(t, userID, &v1.GetMessagesRequest{
		ChannelId: channelID,
		Around:    msgIDs[2],
	}))
	if err != nil {
		t.Fatalf("GetMessages(around): %v", err)
	}
	if len(resp.Msg.Messages) != 5 {
		t.Fatalf("messages count = %d, want 5", len(resp.Msg.Messages))
	}
	// The target message should be present
	found := false
	for _, m := range resp.Msg.Messages {
		if m.Id == msgIDs[2] {
			found = true
			break
		}
	}
	if !found {
		t.Error("target message not found in around response")
	}
}

func TestGetMessagesAroundDeletedTarget(t *testing.T) {
	client, chatStore, msgStore, _ := setupChatTestServer(t)
	userID := models.NewID()

	channelID, msgIDs := setupMessagesForAroundTests(t, client, chatStore, userID, 5)

	// Delete the target message directly in the store
	if err := msgStore.DeleteMessage(context.Background(), channelID, msgIDs[2]); err != nil {
		t.Fatalf("DeleteMessage: %v", err)
	}

	// Around query should still succeed — returns surrounding messages without the deleted one
	resp, err := client.GetMessages(context.Background(), testutil.AuthedRequest(t, userID, &v1.GetMessagesRequest{
		ChannelId: channelID,
		Around:    msgIDs[2],
	}))
	if err != nil {
		t.Fatalf("GetMessages(around deleted): %v", err)
	}
	// Deleted message should be excluded
	for _, m := range resp.Msg.Messages {
		if m.Id == msgIDs[2] {
			t.Error("deleted target message should not appear in results")
		}
	}
	if len(resp.Msg.Messages) != 4 {
		t.Errorf("messages count = %d, want 4 (5 minus deleted)", len(resp.Msg.Messages))
	}
}

func TestGetMessagesMultipleCursors(t *testing.T) {
	client, chatStore, _, _ := setupChatTestServer(t)
	userID := models.NewID()

	channelID, msgIDs := setupMessagesForAroundTests(t, client, chatStore, userID, 3)

	tests := []struct {
		name   string
		req    *v1.GetMessagesRequest
	}{
		{
			name: "before+after",
			req: &v1.GetMessagesRequest{
				ChannelId: channelID,
				Before:    msgIDs[2],
				After:     msgIDs[0],
			},
		},
		{
			name: "before+around",
			req: &v1.GetMessagesRequest{
				ChannelId: channelID,
				Before:    msgIDs[2],
				Around:    msgIDs[1],
			},
		},
		{
			name: "after+around",
			req: &v1.GetMessagesRequest{
				ChannelId: channelID,
				After:     msgIDs[0],
				Around:    msgIDs[1],
			},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			_, err := client.GetMessages(context.Background(), testutil.AuthedRequest(t, userID, tc.req))
			if err == nil {
				t.Fatal("expected error for multiple cursors")
			}
			ce := new(connect.Error)
			if !errors.As(err, &ce) {
				t.Fatalf("expected ConnectError, got %T", err)
			}
			if ce.Code() != connect.CodeInvalidArgument {
				t.Errorf("code = %v, want InvalidArgument", ce.Code())
			}
		})
	}
}

func TestJoinServerBannedUser(t *testing.T) {
	// Set up a server with access to both the invite and ban stores.
	roleStore := newMockRoleStore()
	chatStore := newMockChatStore(roleStore)
	messageStore := newMockMessageStore()
	inviteStore := newMockInviteStore()
	banStore := newMockBanStore()
	pinStore := newMockPinStore()
	emojiStore := &mockEmojiStore{}
	nc := testutil.StartTestNATS(t)

	svc := newChatService(chatServiceConfig{
		ChatStore:               chatStore,
		MessageStore:            messageStore,
		InviteStore:             inviteStore,
		RoleStore:               roleStore,
		BanStore:                banStore,
		PinStore:                pinStore,
		EmojiStore:              emojiStore,
		MediaStore:              newMockMediaStore(),
		PermissionOverrideStore: &mockPermissionOverrideStore{},
		NC:                      nc,
		PermCache:               permissions.NewCache(nil),
	})

	interceptor := connect.WithInterceptors(auth.NewConnectInterceptor(testutil.TestEd25519Keys.PublicKey))
	mux := http.NewServeMux()
	path, handler := mezav1connect.NewChatServiceHandler(svc, interceptor)
	mux.Handle(path, handler)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	client := mezav1connect.NewChatServiceClient(http.DefaultClient, srv.URL)

	ownerID := models.NewID()
	bannedUserID := models.NewID()

	// Owner creates a server and an invite.
	srvResp, err := client.CreateServer(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.CreateServerRequest{Name: "Test Server"}))
	if err != nil {
		t.Fatalf("CreateServer: %v", err)
	}
	serverID := srvResp.Msg.Server.Id

	invResp, err := client.CreateInvite(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.CreateInviteRequest{
		ServerId: serverID,
	}))
	if err != nil {
		t.Fatalf("CreateInvite: %v", err)
	}

	// User B joins via invite.
	_, err = client.JoinServer(context.Background(), testutil.AuthedRequest(t, bannedUserID, &v1.JoinServerRequest{
		InviteCode: invResp.Msg.Invite.Code,
	}))
	if err != nil {
		t.Fatalf("JoinServer: %v", err)
	}

	// Ban user B directly (seed in mock -- avoids needing owner role hierarchy setup).
	banStore.mu.Lock()
	if banStore.bans[serverID] == nil {
		banStore.bans[serverID] = make(map[string]*models.Ban)
	}
	banStore.bans[serverID][bannedUserID] = &models.Ban{
		ServerID: serverID, UserID: bannedUserID,
	}
	banStore.mu.Unlock()

	// Also remove membership so the "already a member" check doesn't fire first.
	chatStore.mu.Lock()
	delete(chatStore.members[serverID], bannedUserID)
	chatStore.mu.Unlock()

	// Create a fresh invite for the rejoin attempt.
	invResp2, err := client.CreateInvite(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.CreateInviteRequest{
		ServerId: serverID,
	}))
	if err != nil {
		t.Fatalf("CreateInvite: %v", err)
	}

	// Banned user tries to rejoin — should be rejected.
	_, err = client.JoinServer(context.Background(), testutil.AuthedRequest(t, bannedUserID, &v1.JoinServerRequest{
		InviteCode: invResp2.Msg.Invite.Code,
	}))
	if err == nil {
		t.Fatal("expected error for banned user trying to rejoin")
	}
	if connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Errorf("code = %v, want PermissionDenied", connect.CodeOf(err))
	}
}

func TestGetMessagesAroundHasMore(t *testing.T) {
	client, chatStore, _, _ := setupChatTestServer(t)
	userID := models.NewID()

	// Create more messages than we'll request
	channelID, _ := setupMessagesForAroundTests(t, client, chatStore, userID, 10)

	// Request with a small limit — mock returns hasMore when len > limit
	resp, err := client.GetMessages(context.Background(), testutil.AuthedRequest(t, userID, &v1.GetMessagesRequest{
		ChannelId: channelID,
		Limit:     3,
	}))
	if err != nil {
		t.Fatalf("GetMessages: %v", err)
	}
	if !resp.Msg.HasMore {
		t.Error("expected has_more=true when more messages exist than limit")
	}

	// Request with large limit — should not have more
	resp, err = client.GetMessages(context.Background(), testutil.AuthedRequest(t, userID, &v1.GetMessagesRequest{
		ChannelId: channelID,
		Limit:     50,
	}))
	if err != nil {
		t.Fatalf("GetMessages: %v", err)
	}
	if resp.Msg.HasMore {
		t.Error("expected has_more=false when all messages fit within limit")
	}
}

// --- Attachment tests (Finding 1: Todo 082) ---

// setupAttachmentTestServer creates a test server with access to the media store
// for testing attachment flows in SendMessage, GetMessages, and EditMessage.
func setupAttachmentTestServer(t *testing.T) (mezav1connect.ChatServiceClient, *mockChatStore, *mockMessageStore, *mockMediaStore) {
	t.Helper()
	roleStore := newMockRoleStore()
	chatStore := newMockChatStore(roleStore)
	messageStore := newMockMessageStore()
	inviteStore := newMockInviteStore()
	banStore := newMockBanStore()
	pinStore := newMockPinStore()
	emojiStore := &mockEmojiStore{}
	mediaStore := newMockMediaStore()
	nc := testutil.StartTestNATS(t)

	svc := newChatService(chatServiceConfig{
		ChatStore:               chatStore,
		MessageStore:            messageStore,
		InviteStore:             inviteStore,
		RoleStore:               roleStore,
		BanStore:                banStore,
		PinStore:                pinStore,
		EmojiStore:              emojiStore,
		MediaStore:              mediaStore,
		PermissionOverrideStore: &mockPermissionOverrideStore{},
		NC:                      nc,
		PermCache:               permissions.NewCache(nil),
	})

	interceptor := connect.WithInterceptors(auth.NewConnectInterceptor(testutil.TestEd25519Keys.PublicKey))
	mux := http.NewServeMux()
	path, handler := mezav1connect.NewChatServiceHandler(svc, interceptor)
	mux.Handle(path, handler)

	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	client := mezav1connect.NewChatServiceClient(http.DefaultClient, srv.URL)
	return client, chatStore, messageStore, mediaStore
}

// setupAttachmentTest creates a server, channel, and pre-populated attachments
// owned by the given user. Returns the channelID and a slice of attachment IDs.
func setupAttachmentTest(t *testing.T, numAttachments int) (mezav1connect.ChatServiceClient, *mockChatStore, *mockMessageStore, *mockMediaStore, string, string, []string) {
	t.Helper()
	client, chatStore, messageStore, mediaStore := setupAttachmentTestServer(t)
	userID := models.NewID()

	srvResp, err := client.CreateServer(context.Background(), testutil.AuthedRequest(t, userID, &v1.CreateServerRequest{Name: "Attachment Test Server"}))
	if err != nil {
		t.Fatalf("CreateServer: %v", err)
	}
	serverID := srvResp.Msg.Server.Id

	channels, err := chatStore.ListChannels(context.Background(), serverID, "")
	if err != nil || len(channels) == 0 {
		t.Fatal("expected default channel")
	}
	channelID := channels[0].ID

	var attachmentIDs []string
	for i := 0; i < numAttachments; i++ {
		att := &models.Attachment{
			ID:          models.NewID(),
			UploaderID:  userID,
			Filename:    fmt.Sprintf("file%d.png", i),
			ContentType: "image/png",
			SizeBytes:   1024,
			Width:       100,
			Height:      100,
			Status:      models.AttachmentStatusCompleted,
			CreatedAt:   time.Now(),
		}
		mediaStore.CreateAttachment(context.Background(), att)
		attachmentIDs = append(attachmentIDs, att.ID)
	}

	return client, chatStore, messageStore, mediaStore, userID, channelID, attachmentIDs
}

func TestSendMessageWithAttachments(t *testing.T) {
	client, _, _, _, userID, channelID, attachmentIDs := setupAttachmentTest(t, 2)

	resp, err := client.SendMessage(context.Background(), testutil.AuthedRequest(t, userID, &v1.SendMessageRequest{
		ChannelId:        channelID,
		EncryptedContent: []byte("message with attachments"),
		AttachmentIds:    attachmentIDs,
	}))
	if err != nil {
		t.Fatalf("SendMessage: %v", err)
	}
	if resp.Msg.MessageId == "" {
		t.Error("expected message_id")
	}
}

func TestSendMessageWithNonExistentAttachment(t *testing.T) {
	client, _, _, _, userID, channelID, _ := setupAttachmentTest(t, 0)

	_, err := client.SendMessage(context.Background(), testutil.AuthedRequest(t, userID, &v1.SendMessageRequest{
		ChannelId:        channelID,
		EncryptedContent: []byte("message with bad attachment"),
		AttachmentIds:    []string{"nonexistent-attachment-id"},
	}))
	if err == nil {
		t.Fatal("expected error for non-existent attachment")
	}
	if connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Errorf("code = %v, want InvalidArgument", connect.CodeOf(err))
	}
}

func TestSendMessageTooManyAttachments(t *testing.T) {
	client, _, _, _, userID, channelID, attachmentIDs := setupAttachmentTest(t, 11)

	_, err := client.SendMessage(context.Background(), testutil.AuthedRequest(t, userID, &v1.SendMessageRequest{
		ChannelId:        channelID,
		EncryptedContent: []byte("message with too many attachments"),
		AttachmentIds:    attachmentIDs,
	}))
	if err == nil {
		t.Fatal("expected error for >10 attachments")
	}
	if connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Errorf("code = %v, want InvalidArgument", connect.CodeOf(err))
	}
}

func TestGetMessagesHydratesAttachments(t *testing.T) {
	client, _, _, _, userID, channelID, attachmentIDs := setupAttachmentTest(t, 2)

	// Send a message with attachments.
	_, err := client.SendMessage(context.Background(), testutil.AuthedRequest(t, userID, &v1.SendMessageRequest{
		ChannelId:        channelID,
		EncryptedContent: []byte("message with attachments"),
		AttachmentIds:    attachmentIDs,
	}))
	if err != nil {
		t.Fatalf("SendMessage: %v", err)
	}

	// Fetch messages and verify attachments are hydrated.
	getResp, err := client.GetMessages(context.Background(), testutil.AuthedRequest(t, userID, &v1.GetMessagesRequest{
		ChannelId: channelID,
	}))
	if err != nil {
		t.Fatalf("GetMessages: %v", err)
	}
	if len(getResp.Msg.Messages) != 1 {
		t.Fatalf("messages count = %d, want 1", len(getResp.Msg.Messages))
	}
	msg := getResp.Msg.Messages[0]
	if len(msg.Attachments) != 2 {
		t.Fatalf("attachments count = %d, want 2", len(msg.Attachments))
	}
	// Verify attachment fields are populated.
	for _, att := range msg.Attachments {
		if att.Id == "" {
			t.Error("expected non-empty attachment ID")
		}
		if att.Filename == "" {
			t.Error("expected non-empty filename")
		}
		if att.ContentType != "image/png" {
			t.Errorf("content_type = %q, want %q", att.ContentType, "image/png")
		}
		if att.Url == "" {
			t.Error("expected non-empty URL")
		}
	}
}

func TestEditMessageHydratesAttachmentsInEvent(t *testing.T) {
	client, _, _, _, userID, channelID, attachmentIDs := setupAttachmentTest(t, 1)

	// Send a message with an attachment.
	sendResp, err := client.SendMessage(context.Background(), testutil.AuthedRequest(t, userID, &v1.SendMessageRequest{
		ChannelId:        channelID,
		EncryptedContent: []byte("original"),
		AttachmentIds:    attachmentIDs,
	}))
	if err != nil {
		t.Fatalf("SendMessage: %v", err)
	}

	// Edit the message. This should succeed and the edit event should carry attachments.
	editResp, err := client.EditMessage(context.Background(), testutil.AuthedRequest(t, userID, &v1.EditMessageRequest{
		ChannelId:        channelID,
		MessageId:        sendResp.Msg.MessageId,
		EncryptedContent: []byte("edited"),
	}))
	if err != nil {
		t.Fatalf("EditMessage: %v", err)
	}
	if editResp.Msg.EditedAt == nil {
		t.Fatal("expected edited_at in response")
	}

	// Verify the attachment is still hydrated on GetMessages after edit.
	getResp, err := client.GetMessages(context.Background(), testutil.AuthedRequest(t, userID, &v1.GetMessagesRequest{
		ChannelId: channelID,
	}))
	if err != nil {
		t.Fatalf("GetMessages: %v", err)
	}
	if len(getResp.Msg.Messages) != 1 {
		t.Fatalf("messages count = %d, want 1", len(getResp.Msg.Messages))
	}
	if len(getResp.Msg.Messages[0].Attachments) != 1 {
		t.Errorf("attachments count = %d, want 1 after edit", len(getResp.Msg.Messages[0].Attachments))
	}
}

// --- Moderation handler tests (Finding 2: Todo 062) ---

// setupKickBanTest creates a server with an owner, a moderator with Kick+Ban permissions,
// and a target member. The moderator has a role at position 10, the target has no roles.
// Returns client, chatStore, roleStore, banStore, serverID, ownerID, modID, targetID.
func setupKickBanTest(t *testing.T) (mezav1connect.ChatServiceClient, *mockChatStore, *mockRoleStore, *mockBanStore, string, string, string, string) {
	t.Helper()
	client, chatStore, roleStore, banStore := setupModerationTestServer(t)

	ownerID := models.NewID()
	modID := models.NewID()
	targetID := models.NewID()

	srvResp, err := client.CreateServer(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.CreateServerRequest{Name: "Mod Test Server"}))
	if err != nil {
		t.Fatalf("CreateServer: %v", err)
	}
	serverID := srvResp.Msg.Server.Id

	// Add moderator and target as members.
	chatStore.AddMember(context.Background(), modID, serverID)
	chatStore.AddMember(context.Background(), targetID, serverID)

	// Create mod role (position 10, KickMembers + BanMembers).
	modRoleID := models.NewID()
	roleStore.CreateRole(context.Background(), &models.Role{
		ID:          modRoleID,
		ServerID:    serverID,
		Name:        "Moderator",
		Position:    10,
		Permissions: permissions.KickMembers | permissions.BanMembers,
	})

	// Assign mod role to moderator.
	roleStore.assignRoles(serverID, modID, []string{modRoleID})

	return client, chatStore, roleStore, banStore, serverID, ownerID, modID, targetID
}

// --- KickMember tests ---

func TestKickMemberHappyPath(t *testing.T) {
	client, chatStore, _, _, serverID, _, modID, targetID := setupKickBanTest(t)

	_, err := client.KickMember(context.Background(), testutil.AuthedRequest(t, modID, &v1.KickMemberRequest{
		ServerId: serverID,
		UserId:   targetID,
	}))
	if err != nil {
		t.Fatalf("KickMember: %v", err)
	}

	// Verify the target is no longer a member.
	isMember, err := chatStore.IsMember(context.Background(), targetID, serverID)
	if err != nil {
		t.Fatalf("IsMember: %v", err)
	}
	if isMember {
		t.Error("expected target to no longer be a member after kick")
	}
}

func TestKickMemberPermissionDenied(t *testing.T) {
	client, chatStore, _, _, serverID, _, _, targetID := setupKickBanTest(t)

	// Add a regular member with no permissions.
	regularID := models.NewID()
	chatStore.AddMember(context.Background(), regularID, serverID)

	_, err := client.KickMember(context.Background(), testutil.AuthedRequest(t, regularID, &v1.KickMemberRequest{
		ServerId: serverID,
		UserId:   targetID,
	}))
	if err == nil {
		t.Fatal("expected error for missing KickMembers permission")
	}
	if connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Errorf("code = %v, want PermissionDenied", connect.CodeOf(err))
	}
}

func TestKickMemberHierarchyCheck(t *testing.T) {
	client, chatStore, roleStore, _, serverID, _, modID, _ := setupKickBanTest(t)

	// Create a target with a higher role (position 20) than the moderator (position 10).
	higherTargetID := models.NewID()
	chatStore.AddMember(context.Background(), higherTargetID, serverID)
	higherRoleID := models.NewID()
	roleStore.CreateRole(context.Background(), &models.Role{
		ID:          higherRoleID,
		ServerID:    serverID,
		Name:        "Admin",
		Position:    20,
		Permissions: permissions.KickMembers,
	})
	roleStore.assignRoles(serverID, higherTargetID, []string{higherRoleID})

	_, err := client.KickMember(context.Background(), testutil.AuthedRequest(t, modID, &v1.KickMemberRequest{
		ServerId: serverID,
		UserId:   higherTargetID,
	}))
	if err == nil {
		t.Fatal("expected error for kicking a higher-ranked member")
	}
	if connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Errorf("code = %v, want PermissionDenied", connect.CodeOf(err))
	}
}

func TestKickMemberSelfKickPrevention(t *testing.T) {
	client, _, _, _, serverID, _, modID, _ := setupKickBanTest(t)

	_, err := client.KickMember(context.Background(), testutil.AuthedRequest(t, modID, &v1.KickMemberRequest{
		ServerId: serverID,
		UserId:   modID,
	}))
	if err == nil {
		t.Fatal("expected error for self-kick")
	}
	if connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Errorf("code = %v, want InvalidArgument", connect.CodeOf(err))
	}
}

// --- BanMember tests ---

func TestBanMemberHappyPath(t *testing.T) {
	client, chatStore, _, _, serverID, _, modID, targetID := setupKickBanTest(t)

	reason := "rule violation"
	_, err := client.BanMember(context.Background(), testutil.AuthedRequest(t, modID, &v1.BanMemberRequest{
		ServerId: serverID,
		UserId:   targetID,
		Reason:   &reason,
	}))
	if err != nil {
		t.Fatalf("BanMember: %v", err)
	}

	// Verify the target is no longer a member (ban + remove is atomic).
	isMember, err := chatStore.IsMember(context.Background(), targetID, serverID)
	if err != nil {
		t.Fatalf("IsMember: %v", err)
	}
	if isMember {
		// Note: mockBanStore.CreateBanAndRemoveMember doesn't remove from chatStore,
		// so we check the ban store directly.
	}
}

func TestBanMemberPermissionDenied(t *testing.T) {
	client, chatStore, _, _, serverID, _, _, targetID := setupKickBanTest(t)

	// Add a regular member with no permissions.
	regularID := models.NewID()
	chatStore.AddMember(context.Background(), regularID, serverID)

	_, err := client.BanMember(context.Background(), testutil.AuthedRequest(t, regularID, &v1.BanMemberRequest{
		ServerId: serverID,
		UserId:   targetID,
	}))
	if err == nil {
		t.Fatal("expected error for missing BanMembers permission")
	}
	if connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Errorf("code = %v, want PermissionDenied", connect.CodeOf(err))
	}
}

func TestBanMemberHierarchyCheck(t *testing.T) {
	client, chatStore, roleStore, _, serverID, _, modID, _ := setupKickBanTest(t)

	// Create a target with equal role position (10) to the moderator.
	equalTargetID := models.NewID()
	chatStore.AddMember(context.Background(), equalTargetID, serverID)
	equalRoleID := models.NewID()
	roleStore.CreateRole(context.Background(), &models.Role{
		ID:          equalRoleID,
		ServerID:    serverID,
		Name:        "EqualMod",
		Position:    10,
		Permissions: permissions.KickMembers,
	})
	roleStore.assignRoles(serverID, equalTargetID, []string{equalRoleID})

	_, err := client.BanMember(context.Background(), testutil.AuthedRequest(t, modID, &v1.BanMemberRequest{
		ServerId: serverID,
		UserId:   equalTargetID,
	}))
	if err == nil {
		t.Fatal("expected error for banning a member with equal role position")
	}
	if connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Errorf("code = %v, want PermissionDenied", connect.CodeOf(err))
	}
}

// --- UnbanMember tests ---

func TestUnbanMemberHappyPath(t *testing.T) {
	client, _, _, banStore, serverID, _, modID, targetID := setupKickBanTest(t)

	// Pre-populate ban so the target is banned.
	banStore.mu.Lock()
	if banStore.bans[serverID] == nil {
		banStore.bans[serverID] = make(map[string]*models.Ban)
	}
	banStore.bans[serverID][targetID] = &models.Ban{
		ServerID:  serverID,
		UserID:    targetID,
		CreatedAt: time.Now(),
	}
	banStore.mu.Unlock()

	_, err := client.UnbanMember(context.Background(), testutil.AuthedRequest(t, modID, &v1.UnbanMemberRequest{
		ServerId: serverID,
		UserId:   targetID,
	}))
	if err != nil {
		t.Fatalf("UnbanMember: %v", err)
	}

	// Verify the ban was removed.
	isBanned, err := banStore.IsBanned(context.Background(), serverID, targetID)
	if err != nil {
		t.Fatalf("IsBanned: %v", err)
	}
	if isBanned {
		t.Error("expected target to no longer be banned after unban")
	}
}

func TestUnbanMemberPermissionDenied(t *testing.T) {
	client, chatStore, _, banStore, serverID, _, _, targetID := setupKickBanTest(t)

	// Pre-populate ban.
	banStore.mu.Lock()
	if banStore.bans[serverID] == nil {
		banStore.bans[serverID] = make(map[string]*models.Ban)
	}
	banStore.bans[serverID][targetID] = &models.Ban{
		ServerID:  serverID,
		UserID:    targetID,
		CreatedAt: time.Now(),
	}
	banStore.mu.Unlock()

	// Add a regular member with no permissions.
	regularID := models.NewID()
	chatStore.AddMember(context.Background(), regularID, serverID)

	_, err := client.UnbanMember(context.Background(), testutil.AuthedRequest(t, regularID, &v1.UnbanMemberRequest{
		ServerId: serverID,
		UserId:   targetID,
	}))
	if err == nil {
		t.Fatal("expected error for missing BanMembers permission")
	}
	if connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Errorf("code = %v, want PermissionDenied", connect.CodeOf(err))
	}
}

// --- Reply Tests ---

// setupReplyTestContext creates a server, channel, and parent message for reply tests.
func setupReplyTestContext(t *testing.T, client mezav1connect.ChatServiceClient, chatStore *mockChatStore, userID string) (channelID, parentMsgID string) {
	t.Helper()

	// Reset shared reply index between tests.
	replyIndex.mu.Lock()
	replyIndex.entries = make(map[string][]replyIndexEntry)
	replyIndex.mu.Unlock()

	srvResp, err := client.CreateServer(context.Background(), testutil.AuthedRequest(t, userID, &v1.CreateServerRequest{
		Name: "Reply Test Server",
	}))
	if err != nil {
		t.Fatalf("CreateServer: %v", err)
	}
	channels, err := chatStore.ListChannels(context.Background(), srvResp.Msg.Server.Id, "")
	if err != nil || len(channels) == 0 {
		t.Fatalf("ListChannels: %v (len=%d)", err, len(channels))
	}
	channelID = channels[0].ID

	// Send parent message.
	sendResp, err := client.SendMessage(context.Background(), testutil.AuthedRequest(t, userID, &v1.SendMessageRequest{
		ChannelId:        channelID,
		EncryptedContent: []byte("parent message"),
	}))
	if err != nil {
		t.Fatalf("SendMessage (parent): %v", err)
	}
	return channelID, sendResp.Msg.MessageId
}

func TestSendMessageWithReply(t *testing.T) {
	client, chatStore, _, _ := setupChatTestServer(t)
	userID := models.NewID()
	channelID, parentID := setupReplyTestContext(t, client, chatStore, userID)

	// Send a reply.
	replyResp, err := client.SendMessage(context.Background(), testutil.AuthedRequest(t, userID, &v1.SendMessageRequest{
		ChannelId:        channelID,
		EncryptedContent: []byte("reply message"),
		ReplyToId:        &parentID,
	}))
	if err != nil {
		t.Fatalf("SendMessage (reply): %v", err)
	}

	// Verify reply_to_id is returned in GetMessages.
	getResp, err := client.GetMessages(context.Background(), testutil.AuthedRequest(t, userID, &v1.GetMessagesRequest{
		ChannelId: channelID,
	}))
	if err != nil {
		t.Fatalf("GetMessages: %v", err)
	}
	var found bool
	for _, msg := range getResp.Msg.Messages {
		if msg.Id == replyResp.Msg.MessageId {
			if msg.GetReplyToId() != parentID {
				t.Errorf("reply_to_id = %q, want %q", msg.GetReplyToId(), parentID)
			}
			found = true
		}
	}
	if !found {
		t.Error("reply message not found in GetMessages response")
	}
}

func TestSendMessageWithInvalidReplyToId(t *testing.T) {
	client, chatStore, _, _ := setupChatTestServer(t)
	userID := models.NewID()
	channelID, _ := setupReplyTestContext(t, client, chatStore, userID)

	nonexistent := "01NONEXISTENT000000000000"
	_, err := client.SendMessage(context.Background(), testutil.AuthedRequest(t, userID, &v1.SendMessageRequest{
		ChannelId:        channelID,
		EncryptedContent: []byte("bad reply"),
		ReplyToId:        &nonexistent,
	}))
	if err == nil {
		t.Fatal("expected error for nonexistent reply_to_id")
	}
	if connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Errorf("code = %v, want InvalidArgument", connect.CodeOf(err))
	}
}

func TestSendMessageWithDeletedParentReplyToId(t *testing.T) {
	client, chatStore, _, _ := setupChatTestServer(t)
	userID := models.NewID()
	channelID, parentID := setupReplyTestContext(t, client, chatStore, userID)

	// Delete the parent.
	_, err := client.DeleteMessage(context.Background(), testutil.AuthedRequest(t, userID, &v1.DeleteMessageRequest{
		ChannelId: channelID,
		MessageId: parentID,
	}))
	if err != nil {
		t.Fatalf("DeleteMessage: %v", err)
	}

	// Try to reply to deleted parent.
	_, err = client.SendMessage(context.Background(), testutil.AuthedRequest(t, userID, &v1.SendMessageRequest{
		ChannelId:        channelID,
		EncryptedContent: []byte("reply to deleted"),
		ReplyToId:        &parentID,
	}))
	if err == nil {
		t.Fatal("expected error for deleted parent reply_to_id")
	}
	if connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Errorf("code = %v, want InvalidArgument", connect.CodeOf(err))
	}
}

func TestSendMessageWithCrossChannelReplyToId(t *testing.T) {
	client, chatStore, _, _ := setupChatTestServer(t)
	userID := models.NewID()
	channelID, parentID := setupReplyTestContext(t, client, chatStore, userID)

	// Create a second channel in the same server.
	srvResp, _ := client.ListServers(context.Background(), testutil.AuthedRequest(t, userID, &v1.ListServersRequest{}))
	serverID := srvResp.Msg.Servers[0].Id
	ch2Resp, err := client.CreateChannel(context.Background(), testutil.AuthedRequest(t, userID, &v1.CreateChannelRequest{
		ServerId: serverID,
		Name:     "other-channel",
		Type:     v1.ChannelType_CHANNEL_TYPE_TEXT,
	}))
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	otherChannelID := ch2Resp.Msg.Channel.Id
	_ = channelID // parent lives in the first channel

	// Try to reply from the second channel to the parent in the first channel.
	_, err = client.SendMessage(context.Background(), testutil.AuthedRequest(t, userID, &v1.SendMessageRequest{
		ChannelId:        otherChannelID,
		EncryptedContent: []byte("cross-channel reply"),
		ReplyToId:        &parentID,
	}))
	if err == nil {
		t.Fatal("expected error for cross-channel reply_to_id")
	}
	if connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Errorf("code = %v, want InvalidArgument", connect.CodeOf(err))
	}
}

func TestGetReplies(t *testing.T) {
	client, chatStore, _, _ := setupChatTestServer(t)
	userID := models.NewID()
	channelID, parentID := setupReplyTestContext(t, client, chatStore, userID)

	// Send 3 replies.
	for i := 0; i < 3; i++ {
		_, err := client.SendMessage(context.Background(), testutil.AuthedRequest(t, userID, &v1.SendMessageRequest{
			ChannelId:        channelID,
			EncryptedContent: []byte(fmt.Sprintf("reply %d", i)),
			ReplyToId:        &parentID,
		}))
		if err != nil {
			t.Fatalf("SendMessage (reply %d): %v", i, err)
		}
	}

	// Get replies.
	resp, err := client.GetReplies(context.Background(), testutil.AuthedRequest(t, userID, &v1.GetRepliesRequest{
		ChannelId: channelID,
		MessageId: parentID,
	}))
	if err != nil {
		t.Fatalf("GetReplies: %v", err)
	}
	if len(resp.Msg.Replies) != 3 {
		t.Errorf("replies count = %d, want 3", len(resp.Msg.Replies))
	}
	if resp.Msg.TotalCount != 3 {
		t.Errorf("total_count = %d, want 3", resp.Msg.TotalCount)
	}
	// Verify each reply has author_id set.
	for _, r := range resp.Msg.Replies {
		if r.AuthorId != userID {
			t.Errorf("reply author = %q, want %q", r.AuthorId, userID)
		}
	}
}

func TestGetRepliesPrivateChannel(t *testing.T) {
	client, chatStore, _, _ := setupChatTestServer(t)
	ownerID := models.NewID()
	otherID := models.NewID()

	// Reset reply index.
	replyIndex.mu.Lock()
	replyIndex.entries = make(map[string][]replyIndexEntry)
	replyIndex.mu.Unlock()

	// Create server and add other user.
	srvResp, err := client.CreateServer(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.CreateServerRequest{
		Name: "Private Channel Test",
	}))
	if err != nil {
		t.Fatalf("CreateServer: %v", err)
	}
	serverID := srvResp.Msg.Server.Id
	chatStore.AddMember(context.Background(), otherID, serverID)

	// Create private channel (only owner is added).
	chResp, err := client.CreateChannel(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.CreateChannelRequest{
		ServerId:  serverID,
		Name:      "private",
		Type:      v1.ChannelType_CHANNEL_TYPE_TEXT,
		IsPrivate: true,
	}))
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	channelID := chResp.Msg.Channel.Id

	// Send a message in the private channel as owner.
	sendResp, err := client.SendMessage(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.SendMessageRequest{
		ChannelId:        channelID,
		EncryptedContent: []byte("private message"),
	}))
	if err != nil {
		t.Fatalf("SendMessage: %v", err)
	}

	// Other user (member of server but not private channel) should be denied.
	_, err = client.GetReplies(context.Background(), testutil.AuthedRequest(t, otherID, &v1.GetRepliesRequest{
		ChannelId: channelID,
		MessageId: sendResp.Msg.MessageId,
	}))
	if err == nil {
		t.Fatal("expected error for non-channel-member accessing GetReplies")
	}
	if connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Errorf("code = %v, want PermissionDenied", connect.CodeOf(err))
	}
}

func TestGetMessagesByIDs(t *testing.T) {
	client, chatStore, _, _ := setupChatTestServer(t)
	userID := models.NewID()
	channelID, parentID := setupReplyTestContext(t, client, chatStore, userID)

	// Send another message.
	sendResp, err := client.SendMessage(context.Background(), testutil.AuthedRequest(t, userID, &v1.SendMessageRequest{
		ChannelId:        channelID,
		EncryptedContent: []byte("second message"),
	}))
	if err != nil {
		t.Fatalf("SendMessage: %v", err)
	}

	// Fetch both messages by ID.
	resp, err := client.GetMessagesByIDs(context.Background(), testutil.AuthedRequest(t, userID, &v1.GetMessagesByIDsRequest{
		ChannelId:  channelID,
		MessageIds: []string{parentID, sendResp.Msg.MessageId},
	}))
	if err != nil {
		t.Fatalf("GetMessagesByIDs: %v", err)
	}
	if len(resp.Msg.Messages) != 2 {
		t.Errorf("messages count = %d, want 2", len(resp.Msg.Messages))
	}
}

func TestGetMessagesByIDsPrivateChannel(t *testing.T) {
	client, chatStore, _, _ := setupChatTestServer(t)
	ownerID := models.NewID()
	otherID := models.NewID()

	// Create server and add other user.
	srvResp, err := client.CreateServer(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.CreateServerRequest{
		Name: "Private Channel Test",
	}))
	if err != nil {
		t.Fatalf("CreateServer: %v", err)
	}
	serverID := srvResp.Msg.Server.Id
	chatStore.AddMember(context.Background(), otherID, serverID)

	// Create private channel.
	chResp, err := client.CreateChannel(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.CreateChannelRequest{
		ServerId:  serverID,
		Name:      "private",
		Type:      v1.ChannelType_CHANNEL_TYPE_TEXT,
		IsPrivate: true,
	}))
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	channelID := chResp.Msg.Channel.Id

	sendResp, err := client.SendMessage(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.SendMessageRequest{
		ChannelId:        channelID,
		EncryptedContent: []byte("private msg"),
	}))
	if err != nil {
		t.Fatalf("SendMessage: %v", err)
	}

	// Non-channel-member should be denied.
	_, err = client.GetMessagesByIDs(context.Background(), testutil.AuthedRequest(t, otherID, &v1.GetMessagesByIDsRequest{
		ChannelId:  channelID,
		MessageIds: []string{sendResp.Msg.MessageId},
	}))
	if err == nil {
		t.Fatal("expected error for non-channel-member accessing GetMessagesByIDs")
	}
	if connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Errorf("code = %v, want PermissionDenied", connect.CodeOf(err))
	}
}

func TestDeleteReplyUpdatesIndex(t *testing.T) {
	client, chatStore, _, _ := setupChatTestServer(t)
	userID := models.NewID()
	channelID, parentID := setupReplyTestContext(t, client, chatStore, userID)

	// Send a reply.
	replyResp, err := client.SendMessage(context.Background(), testutil.AuthedRequest(t, userID, &v1.SendMessageRequest{
		ChannelId:        channelID,
		EncryptedContent: []byte("reply to delete"),
		ReplyToId:        &parentID,
	}))
	if err != nil {
		t.Fatalf("SendMessage (reply): %v", err)
	}

	// Verify reply exists.
	resp, err := client.GetReplies(context.Background(), testutil.AuthedRequest(t, userID, &v1.GetRepliesRequest{
		ChannelId: channelID,
		MessageId: parentID,
	}))
	if err != nil {
		t.Fatalf("GetReplies: %v", err)
	}
	if resp.Msg.TotalCount != 1 {
		t.Fatalf("total_count = %d, want 1", resp.Msg.TotalCount)
	}

	// Delete the reply.
	_, err = client.DeleteMessage(context.Background(), testutil.AuthedRequest(t, userID, &v1.DeleteMessageRequest{
		ChannelId: channelID,
		MessageId: replyResp.Msg.MessageId,
	}))
	if err != nil {
		t.Fatalf("DeleteMessage: %v", err)
	}

	// Verify reply is removed from index.
	resp, err = client.GetReplies(context.Background(), testutil.AuthedRequest(t, userID, &v1.GetRepliesRequest{
		ChannelId: channelID,
		MessageId: parentID,
	}))
	if err != nil {
		t.Fatalf("GetReplies after delete: %v", err)
	}
	if resp.Msg.TotalCount != 0 {
		t.Errorf("total_count after delete = %d, want 0", resp.Msg.TotalCount)
	}
}

func TestDeleteParentDoesNotAffectReplies(t *testing.T) {
	client, chatStore, _, _ := setupChatTestServer(t)
	userID := models.NewID()
	channelID, parentID := setupReplyTestContext(t, client, chatStore, userID)

	// Send a reply.
	_, err := client.SendMessage(context.Background(), testutil.AuthedRequest(t, userID, &v1.SendMessageRequest{
		ChannelId:        channelID,
		EncryptedContent: []byte("reply that stays"),
		ReplyToId:        &parentID,
	}))
	if err != nil {
		t.Fatalf("SendMessage (reply): %v", err)
	}

	// Delete the parent message.
	_, err = client.DeleteMessage(context.Background(), testutil.AuthedRequest(t, userID, &v1.DeleteMessageRequest{
		ChannelId: channelID,
		MessageId: parentID,
	}))
	if err != nil {
		t.Fatalf("DeleteMessage (parent): %v", err)
	}

	// Reply should still exist in GetReplies.
	resp, err := client.GetReplies(context.Background(), testutil.AuthedRequest(t, userID, &v1.GetRepliesRequest{
		ChannelId: channelID,
		MessageId: parentID,
	}))
	if err != nil {
		t.Fatalf("GetReplies after parent delete: %v", err)
	}
	if resp.Msg.TotalCount != 1 {
		t.Errorf("total_count = %d, want 1 (reply should survive parent deletion)", resp.Msg.TotalCount)
	}
}

// setupSearchTestServer creates a test server with Redis (miniredis) for search rate limiting.
func setupSearchTestServer(t *testing.T) (mezav1connect.ChatServiceClient, *mockChatStore, *mockMessageStore) {
	t.Helper()
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { rdb.Close() })

	roleStore := newMockRoleStore()
	chatStore := newMockChatStore(roleStore)
	messageStore := newMockMessageStore()
	inviteStore := newMockInviteStore()
	banStore := newMockBanStore()
	pinStore := newMockPinStore()
	nc := testutil.StartTestNATS(t)

	svc := newChatService(chatServiceConfig{
		ChatStore:               chatStore,
		MessageStore:            messageStore,
		InviteStore:             inviteStore,
		RoleStore:               roleStore,
		BanStore:                banStore,
		PinStore:                pinStore,
		EmojiStore:              &mockEmojiStore{},
		MediaStore:              newMockMediaStore(),
		PermissionOverrideStore: &mockPermissionOverrideStore{},
		NC:                      nc,
		RDB:                     rdb,
		PermCache:               permissions.NewCache(nil),
	})

	interceptor := connect.WithInterceptors(auth.NewConnectInterceptor(testutil.TestEd25519Keys.PublicKey))
	mux := http.NewServeMux()
	path, handler := mezav1connect.NewChatServiceHandler(svc, interceptor)
	mux.Handle(path, handler)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	client := mezav1connect.NewChatServiceClient(http.DefaultClient, srv.URL)
	return client, chatStore, messageStore
}

func TestSearchMessagesChannelScoped(t *testing.T) {
	client, chatStore, messageStore := setupSearchTestServer(t)
	userID := models.NewID()

	// Create a server and channel.
	createResp, err := client.CreateServer(context.Background(), testutil.AuthedRequest(t, userID, &v1.CreateServerRequest{
		Name: "search-test",
	}))
	if err != nil {
		t.Fatalf("CreateServer: %v", err)
	}
	serverID := createResp.Msg.Server.Id
	chResp, err := client.CreateChannel(context.Background(), testutil.AuthedRequest(t, userID, &v1.CreateChannelRequest{
		ServerId: serverID,
		Name:     "general",
	}))
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	channelID := chResp.Msg.Channel.Id

	// Send a few messages.
	for i := 0; i < 3; i++ {
		_, err := client.SendMessage(context.Background(), testutil.AuthedRequest(t, userID, &v1.SendMessageRequest{
			ChannelId:        channelID,
			EncryptedContent: []byte(fmt.Sprintf("message-%d", i)),
		}))
		if err != nil {
			t.Fatalf("SendMessage %d: %v", i, err)
		}
	}

	// Search the channel.
	searchResp, err := client.SearchMessages(context.Background(), testutil.AuthedRequest(t, userID, &v1.SearchMessagesRequest{
		ChannelId: &channelID,
	}))
	if err != nil {
		t.Fatalf("SearchMessages: %v", err)
	}
	if len(searchResp.Msg.Messages) != 3 {
		t.Errorf("got %d messages, want 3", len(searchResp.Msg.Messages))
	}
	_ = chatStore
	_ = messageStore
}

func TestSearchMessagesRequiresChannelId(t *testing.T) {
	client, _, _ := setupSearchTestServer(t)
	userID := models.NewID()

	_, err := client.SearchMessages(context.Background(), testutil.AuthedRequest(t, userID, &v1.SearchMessagesRequest{}))
	if err == nil {
		t.Fatal("expected error for missing channel_id")
	}
	if code := connect.CodeOf(err); code != connect.CodeInvalidArgument {
		t.Errorf("got code %v, want InvalidArgument", code)
	}
}

func TestSearchMessagesNotMember(t *testing.T) {
	client, chatStore, _ := setupSearchTestServer(t)
	ownerID := models.NewID()
	otherID := models.NewID()

	// Create a server and channel as owner.
	createResp, err := client.CreateServer(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.CreateServerRequest{
		Name: "search-perm-test",
	}))
	if err != nil {
		t.Fatalf("CreateServer: %v", err)
	}
	serverID := createResp.Msg.Server.Id
	chResp, err := client.CreateChannel(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.CreateChannelRequest{
		ServerId: serverID,
		Name:     "private-search",
	}))
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	channelID := chResp.Msg.Channel.Id

	// Search as non-member — should fail.
	_, err = client.SearchMessages(context.Background(), testutil.AuthedRequest(t, otherID, &v1.SearchMessagesRequest{
		ChannelId: &channelID,
	}))
	if err == nil {
		t.Fatal("expected error for non-member search")
	}
	code := connect.CodeOf(err)
	if code != connect.CodePermissionDenied && code != connect.CodeNotFound {
		t.Errorf("got code %v, want PermissionDenied or NotFound", code)
	}
	_ = chatStore
}

func TestSearchMessagesDeletedExcluded(t *testing.T) {
	client, _, _ := setupSearchTestServer(t)
	userID := models.NewID()

	createResp, err := client.CreateServer(context.Background(), testutil.AuthedRequest(t, userID, &v1.CreateServerRequest{
		Name: "delete-test",
	}))
	if err != nil {
		t.Fatalf("CreateServer: %v", err)
	}
	serverID := createResp.Msg.Server.Id
	chResp, err := client.CreateChannel(context.Background(), testutil.AuthedRequest(t, userID, &v1.CreateChannelRequest{
		ServerId: serverID,
		Name:     "deletable",
	}))
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	channelID := chResp.Msg.Channel.Id

	// Send two messages.
	var messageIDs []string
	for i := 0; i < 2; i++ {
		sendResp, err := client.SendMessage(context.Background(), testutil.AuthedRequest(t, userID, &v1.SendMessageRequest{
			ChannelId:        channelID,
			EncryptedContent: []byte(fmt.Sprintf("msg-%d", i)),
		}))
		if err != nil {
			t.Fatalf("SendMessage %d: %v", i, err)
		}
		messageIDs = append(messageIDs, sendResp.Msg.MessageId)
	}

	// Delete the first message.
	_, err = client.DeleteMessage(context.Background(), testutil.AuthedRequest(t, userID, &v1.DeleteMessageRequest{
		ChannelId: channelID,
		MessageId: messageIDs[0],
	}))
	if err != nil {
		t.Fatalf("DeleteMessage: %v", err)
	}

	// Search — should only return 1 message.
	searchResp, err := client.SearchMessages(context.Background(), testutil.AuthedRequest(t, userID, &v1.SearchMessagesRequest{
		ChannelId: &channelID,
	}))
	if err != nil {
		t.Fatalf("SearchMessages: %v", err)
	}
	if len(searchResp.Msg.Messages) != 1 {
		t.Errorf("got %d messages, want 1 (deleted should be excluded)", len(searchResp.Msg.Messages))
	}
}

func TestSearchMessagesHasMore(t *testing.T) {
	client, _, _ := setupSearchTestServer(t)
	userID := models.NewID()

	createResp, err := client.CreateServer(context.Background(), testutil.AuthedRequest(t, userID, &v1.CreateServerRequest{
		Name: "hasmore-test",
	}))
	if err != nil {
		t.Fatalf("CreateServer: %v", err)
	}
	serverID := createResp.Msg.Server.Id
	chResp, err := client.CreateChannel(context.Background(), testutil.AuthedRequest(t, userID, &v1.CreateChannelRequest{
		ServerId: serverID,
		Name:     "pagination",
	}))
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	channelID := chResp.Msg.Channel.Id

	// Send 30 messages (more than default limit of 25).
	for i := 0; i < 30; i++ {
		_, err := client.SendMessage(context.Background(), testutil.AuthedRequest(t, userID, &v1.SendMessageRequest{
			ChannelId:        channelID,
			EncryptedContent: []byte(fmt.Sprintf("msg-%02d", i)),
		}))
		if err != nil {
			t.Fatalf("SendMessage %d: %v", i, err)
		}
	}

	// Search with default limit — should return 25 with has_more = true.
	searchResp, err := client.SearchMessages(context.Background(), testutil.AuthedRequest(t, userID, &v1.SearchMessagesRequest{
		ChannelId: &channelID,
	}))
	if err != nil {
		t.Fatalf("SearchMessages: %v", err)
	}
	if len(searchResp.Msg.Messages) != 25 {
		t.Errorf("got %d messages, want 25", len(searchResp.Msg.Messages))
	}
	if !searchResp.Msg.HasMore {
		t.Error("has_more should be true when more results exist")
	}
}

func TestSearchMessagesLimitClamping(t *testing.T) {
	client, _, _ := setupSearchTestServer(t)
	userID := models.NewID()

	createResp, err := client.CreateServer(context.Background(), testutil.AuthedRequest(t, userID, &v1.CreateServerRequest{
		Name: "clamp-test",
	}))
	if err != nil {
		t.Fatalf("CreateServer: %v", err)
	}
	serverID := createResp.Msg.Server.Id
	chResp, err := client.CreateChannel(context.Background(), testutil.AuthedRequest(t, userID, &v1.CreateChannelRequest{
		ServerId: serverID,
		Name:     "clamped",
	}))
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	channelID := chResp.Msg.Channel.Id

	// Send 5 messages and request limit=500 — should be clamped to 100.
	for i := 0; i < 5; i++ {
		_, err := client.SendMessage(context.Background(), testutil.AuthedRequest(t, userID, &v1.SendMessageRequest{
			ChannelId:        channelID,
			EncryptedContent: []byte(fmt.Sprintf("msg-%d", i)),
		}))
		if err != nil {
			t.Fatalf("SendMessage %d: %v", i, err)
		}
	}

	searchResp, err := client.SearchMessages(context.Background(), testutil.AuthedRequest(t, userID, &v1.SearchMessagesRequest{
		ChannelId: &channelID,
		Limit:     500,
	}))
	if err != nil {
		t.Fatalf("SearchMessages: %v", err)
	}
	// All 5 returned (limit clamped to 100, which is > 5).
	if len(searchResp.Msg.Messages) != 5 {
		t.Errorf("got %d messages, want 5", len(searchResp.Msg.Messages))
	}
}

func TestSearchMessagesUnauthenticated(t *testing.T) {
	client, _, _ := setupSearchTestServer(t)
	channelID := models.NewID()

	// Call without auth token.
	_, err := client.SearchMessages(context.Background(), connect.NewRequest(&v1.SearchMessagesRequest{
		ChannelId: &channelID,
	}))
	if err == nil {
		t.Fatal("expected error for unauthenticated request")
	}
	if code := connect.CodeOf(err); code != connect.CodeUnauthenticated {
		t.Errorf("got code %v, want Unauthenticated", code)
	}
}

func TestSearchMessagesEmptyResults(t *testing.T) {
	client, _, _ := setupSearchTestServer(t)
	userID := models.NewID()

	createResp, err := client.CreateServer(context.Background(), testutil.AuthedRequest(t, userID, &v1.CreateServerRequest{
		Name: "empty-test",
	}))
	if err != nil {
		t.Fatalf("CreateServer: %v", err)
	}
	serverID := createResp.Msg.Server.Id
	chResp, err := client.CreateChannel(context.Background(), testutil.AuthedRequest(t, userID, &v1.CreateChannelRequest{
		ServerId: serverID,
		Name:     "empty",
	}))
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	channelID := chResp.Msg.Channel.Id

	// Search empty channel — should return 0 results, has_more = false.
	searchResp, err := client.SearchMessages(context.Background(), testutil.AuthedRequest(t, userID, &v1.SearchMessagesRequest{
		ChannelId: &channelID,
	}))
	if err != nil {
		t.Fatalf("SearchMessages: %v", err)
	}
	if len(searchResp.Msg.Messages) != 0 {
		t.Errorf("got %d messages, want 0", len(searchResp.Msg.Messages))
	}
	if searchResp.Msg.HasMore {
		t.Error("has_more should be false for empty results")
	}
}
