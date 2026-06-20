package main

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/jackc/pgx/v5"
	v1 "github.com/mezalabs/meza/gen/meza/v1"
	"github.com/mezalabs/meza/gen/meza/v1/mezav1connect"
	"github.com/mezalabs/meza/internal/auth"
	"github.com/mezalabs/meza/internal/models"
	"github.com/mezalabs/meza/internal/permissions"
	"github.com/mezalabs/meza/internal/store"
	"github.com/mezalabs/meza/internal/testutil"
	"github.com/livekit/protocol/livekit"
)

// ---------- mock ChatStorer ----------

type mockChatStore struct {
	channels map[string]*models.Channel // channelID -> channel
	members  map[string]map[string]bool // serverID -> set of userIDs
	servers  map[string]*models.Server  // serverID -> server
}

func newMockChatStore() *mockChatStore {
	return &mockChatStore{
		channels: make(map[string]*models.Channel),
		members:  make(map[string]map[string]bool),
		servers:  make(map[string]*models.Server),
	}
}

func (m *mockChatStore) addChannel(ch *models.Channel) {
	m.channels[ch.ID] = ch
}

func (m *mockChatStore) addServer(srv *models.Server) {
	m.servers[srv.ID] = srv
}

func (m *mockChatStore) addMember(serverID, userID string) {
	if m.members[serverID] == nil {
		m.members[serverID] = make(map[string]bool)
	}
	m.members[serverID][userID] = true
}

func (m *mockChatStore) GetChannelAndCheckMembership(_ context.Context, channelID, userID string) (*models.Channel, bool, error) {
	ch, ok := m.channels[channelID]
	if !ok {
		return nil, false, errors.New("channel not found")
	}
	isMember := m.members[ch.ServerID][userID]
	return ch, isMember, nil
}

// Remaining ChatStorer methods — unused, panic if called.
func (m *mockChatStore) CreateServer(context.Context, string, string, *string, bool) (*models.Server, error) {
	panic("not implemented")
}
func (m *mockChatStore) GetServer(_ context.Context, serverID string) (*models.Server, error) {
	srv, ok := m.servers[serverID]
	if !ok {
		return nil, errors.New("server not found")
	}
	return srv, nil
}
func (m *mockChatStore) ListServers(context.Context, string) ([]*models.Server, error) {
	panic("not implemented")
}
func (m *mockChatStore) ListAllServers(_ context.Context) ([]*models.Server, error) {
	return nil, nil
}
func (m *mockChatStore) CreateChannel(context.Context, string, string, int, bool, string) (*models.Channel, error) {
	panic("not implemented")
}
func (m *mockChatStore) GetChannel(context.Context, string) (*models.Channel, error) {
	panic("not implemented")
}
func (m *mockChatStore) ListChannels(_ context.Context, serverID, _ string) ([]*models.Channel, error) {
	var channels []*models.Channel
	for _, ch := range m.channels {
		if ch.ServerID == serverID {
			channels = append(channels, ch)
		}
	}
	return channels, nil
}
func (m *mockChatStore) UpdateChannel(context.Context, string, *string, *string, *int, *bool, *int, *bool, *string, *string) (*models.Channel, error) {
	panic("not implemented")
}
func (m *mockChatStore) DeleteChannel(context.Context, string) error { panic("not implemented") }
func (m *mockChatStore) AddMember(context.Context, string, string) error {
	panic("not implemented")
}
func (m *mockChatStore) RemoveMember(context.Context, string, string) error {
	panic("not implemented")
}
func (m *mockChatStore) IsMember(context.Context, string, string) (bool, error) {
	panic("not implemented")
}
func (m *mockChatStore) GetMemberCount(context.Context, string) (int, error) {
	panic("not implemented")
}
func (m *mockChatStore) ListMembers(context.Context, string, string, int) ([]*models.Member, error) {
	panic("not implemented")
}
func (m *mockChatStore) GetMember(context.Context, string, string) (*models.Member, error) {
	panic("not implemented")
}
func (m *mockChatStore) GetUserChannels(context.Context, string) ([]string, error) {
	panic("not implemented")
}
func (m *mockChatStore) AddChannelMember(context.Context, string, string) error {
	panic("not implemented")
}
func (m *mockChatStore) RemoveChannelMember(context.Context, string, string) error {
	panic("not implemented")
}
func (m *mockChatStore) ListChannelMembers(context.Context, string) ([]*models.Member, error) {
	panic("not implemented")
}
func (m *mockChatStore) IsChannelMember(context.Context, string, string) (bool, error) {
	panic("not implemented")
}
func (m *mockChatStore) RemoveChannelMembersForServer(context.Context, string, string) error {
	panic("not implemented")
}
func (m *mockChatStore) ClearChannelMembers(context.Context, string) error {
	panic("not implemented")
}
func (m *mockChatStore) SetMemberTimeout(context.Context, string, string, *time.Time) error {
	panic("not implemented")
}
func (m *mockChatStore) SetMemberNickname(context.Context, string, string, string) error {
	panic("not implemented")
}
func (m *mockChatStore) CreateDMChannel(context.Context, string, string, string, string) (*models.Channel, bool, error) {
	return nil, false, nil
}
func (m *mockChatStore) CreateGroupDMChannel(context.Context, string, string, []string) (*models.Channel, error) {
	panic("not implemented")
}
func (m *mockChatStore) ListDMChannelsWithParticipants(context.Context, string) ([]*models.DMChannelWithParticipants, error) {
	return nil, nil
}
func (m *mockChatStore) GetDMChannelByPairKey(context.Context, string, string) (*models.Channel, error) {
	return nil, nil
}
func (m *mockChatStore) UpdateDMStatus(context.Context, string, string) error { return nil }
func (m *mockChatStore) ListPendingDMRequests(context.Context, string) ([]*models.DMChannelWithParticipants, error) {
	return nil, nil
}
func (m *mockChatStore) ShareAnyServer(context.Context, string, string) (bool, error) {
	return false, nil
}
func (m *mockChatStore) GetMutualServers(_ context.Context, userID1, userID2 string) ([]*models.Server, error) {
	var mutual []*models.Server
	for serverID, members := range m.members {
		if members[userID1] && members[userID2] {
			if srv, ok := m.servers[serverID]; ok {
				mutual = append(mutual, srv)
			}
		}
	}
	return mutual, nil
}
func (m *mockChatStore) GetDMOtherParticipantID(context.Context, string, string) (string, error) {
	return "", nil
}
func (m *mockChatStore) ListMemberUserIDs(context.Context, string) ([]string, error) {
	return nil, nil
}
func (m *mockChatStore) UpdateServer(context.Context, string, *string, *string, *string, *string, *bool, *bool, *bool, *string) (*models.Server, error) {
	panic("not implemented")
}
func (m *mockChatStore) AcknowledgeRules(context.Context, string, string) (time.Time, error) {
	panic("not implemented")
}
func (m *mockChatStore) CompleteOnboarding(context.Context, string, string, []string, []string) (time.Time, []string, []string, error) {
	panic("not implemented")
}
func (m *mockChatStore) CheckRulesAcknowledged(context.Context, string, string) (bool, error) {
	panic("not implemented")
}
func (m *mockChatStore) GetDefaultChannels(context.Context, string) ([]*models.Channel, error) {
	panic("not implemented")
}
func (m *mockChatStore) GetSelfAssignableRoles(context.Context, string) ([]*models.Role, error) {
	panic("not implemented")
}
func (m *mockChatStore) CreateServerFromTemplate(_ context.Context, _ store.CreateServerFromTemplateParams) (*models.Server, []*models.Channel, []*models.Role, []*models.ChannelGroup, error) {
	return nil, nil, nil, nil, nil
}
func (m *mockChatStore) CountChannelMembers(_ context.Context, _ string) (int, error) {
	return 0, nil
}
func (m *mockChatStore) ListChannelParticipantIDs(_ context.Context, _ string) ([]string, error) {
	return nil, nil
}
func (m *mockChatStore) UpdateChannelPrivacy(context.Context, string, *string, *string, *int, *bool, *int, *bool, *string, *string, bool, string, int64) (*models.Channel, error) {
	panic("not implemented")
}
func (m *mockChatStore) CreateVoiceChannelWithCompanion(_ context.Context, _, _ string, _ bool, _ string) (*models.Channel, *models.Channel, error) {
	return nil, nil, nil
}
func (m *mockChatStore) DeleteChannelWithCompanion(_ context.Context, _, _ string) error {
	return nil
}
func (m *mockChatStore) IsVoiceTextCompanion(_ context.Context, _ string) (bool, error) {
	return false, nil
}
func (m *mockChatStore) UpdateCompanionChannel(_ context.Context, _ string, _, _ *string, _ *string) error {
	return nil
}
func (m *mockChatStore) GetSystemMessageConfig(_ context.Context, _ string) (*models.ServerSystemMessageConfig, error) {
	return nil, nil
}
func (m *mockChatStore) UpsertSystemMessageConfig(_ context.Context, _ string, _ store.UpsertSystemMessageConfigOpts) (*models.ServerSystemMessageConfig, error) {
	return nil, nil
}
func (m *mockChatStore) SetPermissionsSynced(_ context.Context, _ string, _ bool) error {
	return nil
}
func (m *mockChatStore) SyncChannelToCategory(_ context.Context, _, _ string) error {
	return nil
}
func (m *mockChatStore) DeleteChannelGroupWithSnapshot(_ context.Context, _ string) error {
	return nil
}

// ---------- mock RoleStorer ----------

type mockRoleStore struct {
	memberRoles map[string]map[string][]*models.Role // serverID -> userID -> roles
	roles       map[string]*models.Role              // roleID -> role
}

func newMockRoleStore() *mockRoleStore {
	return &mockRoleStore{
		memberRoles: make(map[string]map[string][]*models.Role),
		roles:       make(map[string]*models.Role),
	}
}

func (m *mockRoleStore) addRole(role *models.Role) {
	m.roles[role.ID] = role
}

func (m *mockRoleStore) setMemberRoles(serverID, userID string, roles []*models.Role) {
	if m.memberRoles[serverID] == nil {
		m.memberRoles[serverID] = make(map[string][]*models.Role)
	}
	m.memberRoles[serverID][userID] = roles
}

func (m *mockRoleStore) GetMemberRoles(_ context.Context, userID, serverID string) ([]*models.Role, error) {
	if users, ok := m.memberRoles[serverID]; ok {
		if roles, ok := users[userID]; ok {
			return roles, nil
		}
	}
	return nil, nil
}

func (m *mockRoleStore) CreateRole(context.Context, *models.Role) (*models.Role, error) {
	panic("not implemented")
}
func (m *mockRoleStore) GetRole(_ context.Context, roleID string) (*models.Role, error) {
	if r, ok := m.roles[roleID]; ok {
		return r, nil
	}
	return nil, errors.New("role not found")
}
func (m *mockRoleStore) GetRolesByIDs(context.Context, []string, string) ([]*models.Role, error) {
	panic("not implemented")
}
func (m *mockRoleStore) ListRoles(context.Context, string) ([]*models.Role, error) {
	panic("not implemented")
}
func (m *mockRoleStore) UpdateRole(context.Context, string, *string, *int64, *int, *bool) (*models.Role, error) {
	panic("not implemented")
}
func (m *mockRoleStore) DeleteRole(context.Context, string) error { panic("not implemented") }
func (m *mockRoleStore) SetMemberRoles(context.Context, string, string, []string) error {
	panic("not implemented")
}
func (m *mockRoleStore) ReorderRoles(context.Context, string, []string, int) ([]*models.Role, error) {
	panic("not implemented")
}

// ---------- mock BlockStorer ----------

type mockBlockStore struct {
	blocked map[string]bool // "userA:userB" -> true
}

func newMockBlockStore() *mockBlockStore {
	return &mockBlockStore{blocked: make(map[string]bool)}
}

func (m *mockBlockStore) BlockUser(_ context.Context, blockerID, blockedID string) error {
	m.blocked[blockerID+":"+blockedID] = true
	return nil
}
func (m *mockBlockStore) BlockUserTx(_ context.Context, _ pgx.Tx, _, _ string) error {
	return nil
}
func (m *mockBlockStore) UnblockUser(context.Context, string, string) error { return nil }
func (m *mockBlockStore) IsBlockedEither(_ context.Context, userA, userB string) (bool, error) {
	return m.blocked[userA+":"+userB] || m.blocked[userB+":"+userA], nil
}
func (m *mockBlockStore) ListBlocks(context.Context, string) ([]string, error) { return nil, nil }
func (m *mockBlockStore) ListBlocksWithUsers(context.Context, string) ([]*models.User, error) {
	return nil, nil
}

// ---------- mock LiveKit room client ----------

type mockLKClient struct {
	rooms        map[string]bool // room name -> exists
	participants map[string][]*livekit.ParticipantInfo
	removed      []*livekit.RoomParticipantIdentity
}

func newMockLKClient() *mockLKClient {
	return &mockLKClient{
		rooms:        make(map[string]bool),
		participants: make(map[string][]*livekit.ParticipantInfo),
	}
}

func (m *mockLKClient) CreateRoom(_ context.Context, req *livekit.CreateRoomRequest) (*livekit.Room, error) {
	m.rooms[req.Name] = true
	return &livekit.Room{Name: req.Name}, nil
}

func (m *mockLKClient) ListParticipants(_ context.Context, req *livekit.ListParticipantsRequest) (*livekit.ListParticipantsResponse, error) {
	if !m.rooms[req.Room] {
		return nil, errors.New("room not found")
	}
	return &livekit.ListParticipantsResponse{
		Participants: m.participants[req.Room],
	}, nil
}

func (m *mockLKClient) GetParticipant(_ context.Context, req *livekit.RoomParticipantIdentity) (*livekit.ParticipantInfo, error) {
	if !m.rooms[req.Room] {
		return nil, errors.New("room not found")
	}
	for _, p := range m.participants[req.Room] {
		if p.Identity == req.Identity {
			return p, nil
		}
	}
	return nil, errors.New("participant not found")
}

func (m *mockLKClient) RemoveParticipant(_ context.Context, req *livekit.RoomParticipantIdentity) (*livekit.RemoveParticipantResponse, error) {
	m.removed = append(m.removed, req)
	return &livekit.RemoveParticipantResponse{}, nil
}

// ---------- test helpers ----------

func setupVoiceTest(t *testing.T) (mezav1connect.VoiceServiceClient, *mockChatStore, *mockLKClient, *mockRoleStore) {
	t.Helper()

	chatStore := newMockChatStore()
	roleStore := newMockRoleStore()
	blockStore := newMockBlockStore()
	lkClient := newMockLKClient()

	svc := &voiceService{
		chatStore:   chatStore,
		roleStore:   roleStore,
		blockStore:  blockStore,
		lkClient:    lkClient,
		lkKey:       "test-api-key",
		lkSecret:    "test-api-secret-that-is-long-enough",
		lkHost:      "wss://lk.example.com",
		lkPublicURL: "wss://lk.example.com",
	}

	interceptor := connect.WithInterceptors(auth.NewConnectInterceptor(testutil.TestEd25519Keys.PublicKey))
	mux := http.NewServeMux()
	path, handler := mezav1connect.NewVoiceServiceHandler(svc, interceptor)
	mux.Handle(path, handler)

	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	client := mezav1connect.NewVoiceServiceClient(http.DefaultClient, srv.URL)
	return client, chatStore, lkClient, roleStore
}

// ---------- tests ----------

func TestJoinVoiceChannelSuccess(t *testing.T) {
	client, cs, lk, rs := setupVoiceTest(t)

	userID := models.NewID()
	serverID := models.NewID()
	channelID := models.NewID()

	cs.addServer(&models.Server{ID: serverID, OwnerID: models.NewID()})
	rs.addRole(&models.Role{ID: serverID, Permissions: permissions.DefaultEveryonePermissions})
	cs.addChannel(&models.Channel{
		ID:       channelID,
		ServerID: serverID,
		Name:     "voice-chat",
		Type:     channelTypeVoice,
	})
	cs.addMember(serverID, userID)

	resp, err := client.JoinVoiceChannel(context.Background(), testutil.AuthedRequest(t, userID, &v1.JoinVoiceChannelRequest{
		ChannelId: channelID,
	}))
	if err != nil {
		t.Fatalf("JoinVoiceChannel: %v", err)
	}

	if resp.Msg.LivekitUrl != "wss://lk.example.com" {
		t.Errorf("LivekitUrl = %q, want %q", resp.Msg.LivekitUrl, "wss://lk.example.com")
	}
	if resp.Msg.RoomName != "meza-"+channelID {
		t.Errorf("RoomName = %q, want %q", resp.Msg.RoomName, "meza-"+channelID)
	}
	if resp.Msg.LivekitToken == "" {
		t.Error("LivekitToken is empty")
	}

	// Verify the room was created in the mock.
	if !lk.rooms["meza-"+channelID] {
		t.Error("expected LiveKit room to be created")
	}
}

func TestJoinVoiceChannelRejectsNonVoiceChannel(t *testing.T) {
	client, cs, _, _ := setupVoiceTest(t)

	userID := models.NewID()
	serverID := models.NewID()
	channelID := models.NewID()

	cs.addChannel(&models.Channel{
		ID:       channelID,
		ServerID: serverID,
		Name:     "general",
		Type:     1, // CHANNEL_TYPE_TEXT
	})
	cs.addMember(serverID, userID)

	_, err := client.JoinVoiceChannel(context.Background(), testutil.AuthedRequest(t, userID, &v1.JoinVoiceChannelRequest{
		ChannelId: channelID,
	}))
	if err == nil {
		t.Fatal("expected error for non-voice channel, got nil")
	}

	var connErr *connect.Error
	if !errors.As(err, &connErr) {
		t.Fatalf("expected connect.Error, got %T", err)
	}
	if connErr.Code() != connect.CodeInvalidArgument {
		t.Errorf("code = %v, want %v", connErr.Code(), connect.CodeInvalidArgument)
	}
}

func TestJoinVoiceChannelRejectsNonMember(t *testing.T) {
	client, cs, _, _ := setupVoiceTest(t)

	userID := models.NewID()
	serverID := models.NewID()
	channelID := models.NewID()

	cs.addChannel(&models.Channel{
		ID:       channelID,
		ServerID: serverID,
		Name:     "voice-chat",
		Type:     channelTypeVoice,
	})
	// Note: do NOT add the user as a member.

	_, err := client.JoinVoiceChannel(context.Background(), testutil.AuthedRequest(t, userID, &v1.JoinVoiceChannelRequest{
		ChannelId: channelID,
	}))
	if err == nil {
		t.Fatal("expected error for non-member, got nil")
	}

	var connErr *connect.Error
	if !errors.As(err, &connErr) {
		t.Fatalf("expected connect.Error, got %T", err)
	}
	if connErr.Code() != connect.CodePermissionDenied {
		t.Errorf("code = %v, want %v", connErr.Code(), connect.CodePermissionDenied)
	}
}

func TestJoinVoiceChannelRejectsUnauthenticated(t *testing.T) {
	client, cs, _, _ := setupVoiceTest(t)

	channelID := models.NewID()
	serverID := models.NewID()
	cs.addChannel(&models.Channel{
		ID:       channelID,
		ServerID: serverID,
		Name:     "voice-chat",
		Type:     channelTypeVoice,
	})

	// Send request without auth token.
	_, err := client.JoinVoiceChannel(context.Background(), connect.NewRequest(&v1.JoinVoiceChannelRequest{
		ChannelId: channelID,
	}))
	if err == nil {
		t.Fatal("expected error for unauthenticated request, got nil")
	}

	var connErr *connect.Error
	if !errors.As(err, &connErr) {
		t.Fatalf("expected connect.Error, got %T", err)
	}
	if connErr.Code() != connect.CodeUnauthenticated {
		t.Errorf("code = %v, want %v", connErr.Code(), connect.CodeUnauthenticated)
	}
}

func TestGetVoiceChannelStateSuccess(t *testing.T) {
	client, cs, lk, _ := setupVoiceTest(t)

	userID := models.NewID()
	otherUserID := models.NewID()
	serverID := models.NewID()
	channelID := models.NewID()

	cs.addChannel(&models.Channel{
		ID:       channelID,
		ServerID: serverID,
		Name:     "voice-chat",
		Type:     channelTypeVoice,
	})
	cs.addMember(serverID, userID)

	rn := "meza-" + channelID
	lk.rooms[rn] = true
	lk.participants[rn] = []*livekit.ParticipantInfo{
		{
			Identity: otherUserID,
			Tracks: []*livekit.TrackInfo{
				{Source: livekit.TrackSource_MICROPHONE, Muted: false},
			},
		},
	}

	resp, err := client.GetVoiceChannelState(context.Background(), testutil.AuthedRequest(t, userID, &v1.GetVoiceChannelStateRequest{
		ChannelId: channelID,
	}))
	if err != nil {
		t.Fatalf("GetVoiceChannelState: %v", err)
	}

	if len(resp.Msg.Participants) != 1 {
		t.Fatalf("participants count = %d, want 1", len(resp.Msg.Participants))
	}

	p := resp.Msg.Participants[0]
	if p.UserId != otherUserID {
		t.Errorf("participant user_id = %q, want %q", p.UserId, otherUserID)
	}
	if p.IsMuted {
		t.Error("participant should not be muted")
	}
}

func TestGetVoiceChannelStateRoomNotFound(t *testing.T) {
	client, cs, _, _ := setupVoiceTest(t)

	userID := models.NewID()
	serverID := models.NewID()
	channelID := models.NewID()

	cs.addChannel(&models.Channel{
		ID:       channelID,
		ServerID: serverID,
		Name:     "voice-chat",
		Type:     channelTypeVoice,
	})
	cs.addMember(serverID, userID)

	// Room does not exist in LiveKit mock, should return empty list.
	resp, err := client.GetVoiceChannelState(context.Background(), testutil.AuthedRequest(t, userID, &v1.GetVoiceChannelStateRequest{
		ChannelId: channelID,
	}))
	if err != nil {
		t.Fatalf("GetVoiceChannelState: %v", err)
	}

	if len(resp.Msg.Participants) != 0 {
		t.Errorf("participants count = %d, want 0", len(resp.Msg.Participants))
	}
}

func TestLeaveVoiceChannelSuccess(t *testing.T) {
	client, cs, lk, _ := setupVoiceTest(t)

	userID := models.NewID()
	serverID := models.NewID()
	channelID := models.NewID()

	cs.addChannel(&models.Channel{
		ID:       channelID,
		ServerID: serverID,
		Name:     "voice-chat",
		Type:     channelTypeVoice,
	})
	cs.addMember(serverID, userID)

	_, err := client.LeaveVoiceChannel(context.Background(), testutil.AuthedRequest(t, userID, &v1.LeaveVoiceChannelRequest{
		ChannelId: channelID,
	}))
	if err != nil {
		t.Fatalf("LeaveVoiceChannel: %v", err)
	}

	// Verify RemoveParticipant was called.
	if len(lk.removed) != 1 {
		t.Fatalf("expected 1 RemoveParticipant call, got %d", len(lk.removed))
	}
	if lk.removed[0].Identity != userID {
		t.Errorf("removed identity = %q, want %q", lk.removed[0].Identity, userID)
	}
	if lk.removed[0].Room != "meza-"+channelID {
		t.Errorf("removed room = %q, want %q", lk.removed[0].Room, "meza-"+channelID)
	}
}

func TestJoinVoiceChannelScreenSharePermission(t *testing.T) {
	client, cs, lk, rs := setupVoiceTest(t)

	ownerID := models.NewID()
	userWithPerm := models.NewID()
	userWithoutPerm := models.NewID()
	serverID := models.NewID()
	channelID := models.NewID()

	everyoneOnlyUser := models.NewID()

	cs.addServer(&models.Server{ID: serverID, OwnerID: ownerID})
	// @everyone role without StreamVideo — tests below verify explicit role grants.
	rs.addRole(&models.Role{ID: serverID, Permissions: permissions.DefaultEveryonePermissions})
	cs.addChannel(&models.Channel{
		ID:       channelID,
		ServerID: serverID,
		Name:     "voice-chat",
		Type:     channelTypeVoice,
	})
	cs.addMember(serverID, ownerID)
	cs.addMember(serverID, userWithPerm)
	cs.addMember(serverID, userWithoutPerm)
	cs.addMember(serverID, everyoneOnlyUser)

	// Give userWithPerm a role with StreamVideo.
	rs.setMemberRoles(serverID, userWithPerm, []*models.Role{
		{ID: models.NewID(), Permissions: permissions.StreamVideo},
	})

	t.Run("server owner gets screen share", func(t *testing.T) {
		resp, err := client.JoinVoiceChannel(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.JoinVoiceChannelRequest{
			ChannelId: channelID,
		}))
		if err != nil {
			t.Fatalf("JoinVoiceChannel: %v", err)
		}
		if !resp.Msg.CanScreenShare {
			t.Error("server owner should have CanScreenShare = true")
		}
	})

	t.Run("user with StreamVideo role gets screen share", func(t *testing.T) {
		resp, err := client.JoinVoiceChannel(context.Background(), testutil.AuthedRequest(t, userWithPerm, &v1.JoinVoiceChannelRequest{
			ChannelId: channelID,
		}))
		if err != nil {
			t.Fatalf("JoinVoiceChannel: %v", err)
		}
		if !resp.Msg.CanScreenShare {
			t.Error("user with StreamVideo should have CanScreenShare = true")
		}
	})

	t.Run("user without StreamVideo role denied screen share", func(t *testing.T) {
		resp, err := client.JoinVoiceChannel(context.Background(), testutil.AuthedRequest(t, userWithoutPerm, &v1.JoinVoiceChannelRequest{
			ChannelId: channelID,
		}))
		if err != nil {
			t.Fatalf("JoinVoiceChannel: %v", err)
		}
		if resp.Msg.CanScreenShare {
			t.Error("user without StreamVideo should have CanScreenShare = false")
		}
	})

	t.Run("everyone role with StreamVideo grants screen share", func(t *testing.T) {
		// Update @everyone to include StreamVideo (as in the default SafeEveryonePermissions).
		rs.addRole(&models.Role{ID: serverID, Permissions: permissions.SafeEveryonePermissions})
		resp, err := client.JoinVoiceChannel(context.Background(), testutil.AuthedRequest(t, everyoneOnlyUser, &v1.JoinVoiceChannelRequest{
			ChannelId: channelID,
		}))
		if err != nil {
			t.Fatalf("JoinVoiceChannel: %v", err)
		}
		if !resp.Msg.CanScreenShare {
			t.Error("user with only @everyone (which has StreamVideo) should have CanScreenShare = true")
		}
	})

	// Sanity: rooms should have been created.
	if !lk.rooms["meza-"+channelID] {
		t.Error("expected LiveKit room to be created")
	}
}

func TestGetVoiceChannelStateStreamingVideo(t *testing.T) {
	client, cs, lk, _ := setupVoiceTest(t)

	userID := models.NewID()
	sharerID := models.NewID()
	serverID := models.NewID()
	channelID := models.NewID()

	cs.addChannel(&models.Channel{
		ID:       channelID,
		ServerID: serverID,
		Name:     "voice-chat",
		Type:     channelTypeVoice,
	})
	cs.addMember(serverID, userID)

	rn := "meza-" + channelID
	lk.rooms[rn] = true
	lk.participants[rn] = []*livekit.ParticipantInfo{
		{
			Identity: sharerID,
			Tracks: []*livekit.TrackInfo{
				{Source: livekit.TrackSource_MICROPHONE, Muted: false},
				{Source: livekit.TrackSource_SCREEN_SHARE, Muted: false},
			},
		},
	}

	resp, err := client.GetVoiceChannelState(context.Background(), testutil.AuthedRequest(t, userID, &v1.GetVoiceChannelStateRequest{
		ChannelId: channelID,
	}))
	if err != nil {
		t.Fatalf("GetVoiceChannelState: %v", err)
	}

	if len(resp.Msg.Participants) != 1 {
		t.Fatalf("participants count = %d, want 1", len(resp.Msg.Participants))
	}

	p := resp.Msg.Participants[0]
	if !p.IsStreamingVideo {
		t.Error("participant with screen share track should have IsStreamingVideo = true")
	}
}

func TestHasScreenShareTrack(t *testing.T) {
	tests := []struct {
		name   string
		tracks []*livekit.TrackInfo
		want   bool
	}{
		{"no tracks", nil, false},
		{"only microphone", []*livekit.TrackInfo{{Source: livekit.TrackSource_MICROPHONE}}, false},
		{"screen share present", []*livekit.TrackInfo{
			{Source: livekit.TrackSource_MICROPHONE},
			{Source: livekit.TrackSource_SCREEN_SHARE},
		}, true},
		{"only screen share", []*livekit.TrackInfo{{Source: livekit.TrackSource_SCREEN_SHARE}}, true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			p := &livekit.ParticipantInfo{Tracks: tt.tracks}
			if got := hasScreenShareTrack(p); got != tt.want {
				t.Errorf("hasScreenShareTrack() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestIsParticipantMuted(t *testing.T) {
	tests := []struct {
		name   string
		tracks []*livekit.TrackInfo
		want   bool
	}{
		{
			name:   "no tracks",
			tracks: nil,
			want:   true,
		},
		{
			name: "microphone unmuted",
			tracks: []*livekit.TrackInfo{
				{Source: livekit.TrackSource_MICROPHONE, Muted: false},
			},
			want: false,
		},
		{
			name: "microphone muted",
			tracks: []*livekit.TrackInfo{
				{Source: livekit.TrackSource_MICROPHONE, Muted: true},
			},
			want: true,
		},
		{
			name: "only video track",
			tracks: []*livekit.TrackInfo{
				{Source: livekit.TrackSource_CAMERA, Muted: false},
			},
			want: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			p := &livekit.ParticipantInfo{Tracks: tt.tracks}
			got := isParticipantMuted(p)
			if got != tt.want {
				t.Errorf("isParticipantMuted() = %v, want %v", got, tt.want)
			}
		})
	}
}
