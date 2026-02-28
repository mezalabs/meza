package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"connectrpc.com/connect"
	v1 "github.com/meza-chat/meza/gen/meza/v1"
	"github.com/meza-chat/meza/gen/meza/v1/mezav1connect"
	"github.com/meza-chat/meza/internal/auth"
	"github.com/meza-chat/meza/internal/models"
	"github.com/meza-chat/meza/internal/permissions"
	"github.com/meza-chat/meza/internal/testutil"
)

// channelMemberAwareMockChatStore extends mockChatStore with working channel member tracking.
type channelMemberAwareMockChatStore struct {
	mockChatStore
	chanMembers map[string]map[string]bool // channelID -> userID -> bool
}

func newChannelMemberAwareMockChatStore(rs *mockRoleStore) *channelMemberAwareMockChatStore {
	return &channelMemberAwareMockChatStore{
		mockChatStore: mockChatStore{
			servers:   make(map[string]*models.Server),
			channels:  make(map[string]*models.Channel),
			members:   make(map[string]map[string]bool),
			roleStore: rs,
		},
		chanMembers: make(map[string]map[string]bool),
	}
}

func (m *channelMemberAwareMockChatStore) AddChannelMember(_ context.Context, channelID, userID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.chanMembers[channelID] == nil {
		m.chanMembers[channelID] = make(map[string]bool)
	}
	m.chanMembers[channelID][userID] = true
	return nil
}

func (m *channelMemberAwareMockChatStore) RemoveChannelMember(_ context.Context, channelID, userID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.chanMembers[channelID] != nil {
		delete(m.chanMembers[channelID], userID)
	}
	return nil
}

func (m *channelMemberAwareMockChatStore) ListChannelMembers(_ context.Context, channelID string) ([]*models.Member, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var members []*models.Member
	if m.chanMembers[channelID] != nil {
		for uid := range m.chanMembers[channelID] {
			members = append(members, &models.Member{
				UserID:   uid,
				JoinedAt: time.Now(),
			})
		}
	}
	return members, nil
}

func (m *channelMemberAwareMockChatStore) IsChannelMember(_ context.Context, channelID, userID string) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.chanMembers[channelID] != nil {
		return m.chanMembers[channelID][userID], nil
	}
	return false, nil
}

func (m *channelMemberAwareMockChatStore) ListChannelParticipantIDs(_ context.Context, channelID string) ([]string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var ids []string
	if m.chanMembers[channelID] != nil {
		for uid := range m.chanMembers[channelID] {
			ids = append(ids, uid)
		}
	}
	return ids, nil
}

func (m *channelMemberAwareMockChatStore) CountChannelMembers(_ context.Context, channelID string) (int, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.chanMembers[channelID] != nil {
		return len(m.chanMembers[channelID]), nil
	}
	return 0, nil
}

func (m *channelMemberAwareMockChatStore) RemoveChannelMembersForServer(_ context.Context, userID, serverID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for chID, ch := range m.channels {
		if ch.ServerID == serverID {
			if m.chanMembers[chID] != nil {
				delete(m.chanMembers[chID], userID)
			}
		}
	}
	return nil
}

func (m *channelMemberAwareMockChatStore) ClearChannelMembers(_ context.Context, channelID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.chanMembers, channelID)
	return nil
}

// setupChannelMemberTestServer creates a test server with channel-member-aware chat store.
func setupChannelMemberTestServer(t *testing.T) (mezav1connect.ChatServiceClient, *channelMemberAwareMockChatStore, *mockRoleStore) {
	t.Helper()
	roleStore := newMockRoleStore()
	chatStore := newChannelMemberAwareMockChatStore(roleStore)
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
	return client, chatStore, roleStore
}

// setupChannelMemberScenario creates a server with a private channel.
func setupChannelMemberScenario(t *testing.T) (mezav1connect.ChatServiceClient, string, string, string, *channelMemberAwareMockChatStore, *mockRoleStore) {
	t.Helper()
	client, chatStore, roleStore := setupChannelMemberTestServer(t)

	ownerID := models.NewID()
	memberID := models.NewID()

	srvResp, err := client.CreateServer(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.CreateServerRequest{Name: "Channel Test Server"}))
	if err != nil {
		t.Fatalf("CreateServer: %v", err)
	}
	serverID := srvResp.Msg.Server.Id

	// Add member.
	chatStore.AddMember(context.Background(), memberID, serverID)

	// Create a private channel.
	chResp, err := client.CreateChannel(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.CreateChannelRequest{
		ServerId:  serverID,
		Name:      "private-room",
		Type:      v1.ChannelType_CHANNEL_TYPE_TEXT,
		IsPrivate: true,
	}))
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	channelID := chResp.Msg.Channel.Id

	return client, serverID, channelID, ownerID, chatStore, roleStore
}

// --- AddChannelMember tests ---

func TestAddChannelMemberSuccess(t *testing.T) {
	client, serverID, channelID, ownerID, chatStore, _ := setupChannelMemberScenario(t)

	targetID := models.NewID()
	chatStore.AddMember(context.Background(), targetID, serverID)

	_, err := client.AddChannelMember(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.AddChannelMemberRequest{
		ChannelId: channelID,
		UserId:    targetID,
	}))
	if err != nil {
		t.Fatalf("AddChannelMember: %v", err)
	}

	// Verify channel membership.
	isMember, _ := chatStore.IsChannelMember(context.Background(), channelID, targetID)
	if !isMember {
		t.Error("expected target to be a channel member")
	}
}

func TestAddChannelMemberNoPermission(t *testing.T) {
	client, serverID, channelID, _, chatStore, _ := setupChannelMemberScenario(t)

	// User without ManageChannels.
	noPermUserID := models.NewID()
	chatStore.AddMember(context.Background(), noPermUserID, serverID)

	targetID := models.NewID()
	chatStore.AddMember(context.Background(), targetID, serverID)

	_, err := client.AddChannelMember(context.Background(), testutil.AuthedRequest(t, noPermUserID, &v1.AddChannelMemberRequest{
		ChannelId: channelID,
		UserId:    targetID,
	}))
	if err == nil {
		t.Fatal("expected error for missing ManageChannels")
	}
	if connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Errorf("code = %v, want PermissionDenied", connect.CodeOf(err))
	}
}

func TestAddChannelMemberNotServerMember(t *testing.T) {
	client, _, channelID, ownerID, _, _ := setupChannelMemberScenario(t)

	// Target is not a server member.
	nonMemberID := models.NewID()

	_, err := client.AddChannelMember(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.AddChannelMemberRequest{
		ChannelId: channelID,
		UserId:    nonMemberID,
	}))
	if err == nil {
		t.Fatal("expected error for non-server-member target")
	}
	if connect.CodeOf(err) != connect.CodeFailedPrecondition {
		t.Errorf("code = %v, want FailedPrecondition", connect.CodeOf(err))
	}
}

func TestAddChannelMemberPublicChannel(t *testing.T) {
	client, serverID, _, ownerID, chatStore, _ := setupChannelMemberScenario(t)

	// Find the public "general" channel.
	channels, _ := chatStore.ListChannels(context.Background(), serverID, "")
	var publicChannelID string
	for _, ch := range channels {
		if !ch.IsPrivate {
			publicChannelID = ch.ID
			break
		}
	}
	if publicChannelID == "" {
		t.Fatal("expected a public channel")
	}

	targetID := models.NewID()
	chatStore.AddMember(context.Background(), targetID, serverID)

	// With universal E2EE, all channels support explicit member management
	// for key distribution tracking.
	_, err := client.AddChannelMember(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.AddChannelMemberRequest{
		ChannelId: publicChannelID,
		UserId:    targetID,
	}))
	if err != nil {
		t.Fatalf("AddChannelMember (public): %v", err)
	}
}

func TestAddChannelMemberIdempotent(t *testing.T) {
	client, serverID, channelID, ownerID, chatStore, _ := setupChannelMemberScenario(t)

	targetID := models.NewID()
	chatStore.AddMember(context.Background(), targetID, serverID)

	// Add twice — should succeed (idempotent).
	_, err := client.AddChannelMember(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.AddChannelMemberRequest{
		ChannelId: channelID,
		UserId:    targetID,
	}))
	if err != nil {
		t.Fatalf("first AddChannelMember: %v", err)
	}

	_, err = client.AddChannelMember(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.AddChannelMemberRequest{
		ChannelId: channelID,
		UserId:    targetID,
	}))
	if err != nil {
		t.Fatalf("second AddChannelMember (idempotent): %v", err)
	}
}

// --- RemoveChannelMember tests ---

func TestRemoveChannelMemberByAdmin(t *testing.T) {
	client, serverID, channelID, ownerID, chatStore, _ := setupChannelMemberScenario(t)

	targetID := models.NewID()
	chatStore.AddMember(context.Background(), targetID, serverID)
	chatStore.AddChannelMember(context.Background(), channelID, targetID)

	_, err := client.RemoveChannelMember(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.RemoveChannelMemberRequest{
		ChannelId: channelID,
		UserId:    targetID,
	}))
	if err != nil {
		t.Fatalf("RemoveChannelMember: %v", err)
	}

	isMember, _ := chatStore.IsChannelMember(context.Background(), channelID, targetID)
	if isMember {
		t.Error("expected target to be removed from channel")
	}
}

func TestRemoveChannelMemberSelfRemoval(t *testing.T) {
	client, serverID, channelID, _, chatStore, _ := setupChannelMemberScenario(t)

	memberID := models.NewID()
	chatStore.AddMember(context.Background(), memberID, serverID)
	chatStore.AddChannelMember(context.Background(), channelID, memberID)

	// Self-removal should work without ManageChannels.
	_, err := client.RemoveChannelMember(context.Background(), testutil.AuthedRequest(t, memberID, &v1.RemoveChannelMemberRequest{
		ChannelId: channelID,
		UserId:    memberID,
	}))
	if err != nil {
		t.Fatalf("RemoveChannelMember (self): %v", err)
	}

	isMember, _ := chatStore.IsChannelMember(context.Background(), channelID, memberID)
	if isMember {
		t.Error("expected member to be removed from channel")
	}
}

func TestRemoveChannelMemberNoPermission(t *testing.T) {
	client, serverID, channelID, _, chatStore, _ := setupChannelMemberScenario(t)

	// User without ManageChannels tries to remove another user.
	noPermUserID := models.NewID()
	chatStore.AddMember(context.Background(), noPermUserID, serverID)

	targetID := models.NewID()
	chatStore.AddMember(context.Background(), targetID, serverID)
	chatStore.AddChannelMember(context.Background(), channelID, targetID)

	_, err := client.RemoveChannelMember(context.Background(), testutil.AuthedRequest(t, noPermUserID, &v1.RemoveChannelMemberRequest{
		ChannelId: channelID,
		UserId:    targetID,
	}))
	if err == nil {
		t.Fatal("expected error for missing ManageChannels")
	}
	if connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Errorf("code = %v, want PermissionDenied", connect.CodeOf(err))
	}
}

func TestRemoveChannelMemberPublicChannel(t *testing.T) {
	client, serverID, _, ownerID, chatStore, _ := setupChannelMemberScenario(t)

	channels, _ := chatStore.ListChannels(context.Background(), serverID, "")
	var publicChannelID string
	for _, ch := range channels {
		if !ch.IsPrivate {
			publicChannelID = ch.ID
			break
		}
	}
	if publicChannelID == "" {
		t.Fatal("expected a public channel")
	}

	targetID := models.NewID()
	chatStore.AddMember(context.Background(), targetID, serverID)

	// With universal E2EE, all channels support explicit member management
	// for key distribution tracking.
	_, err := client.RemoveChannelMember(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.RemoveChannelMemberRequest{
		ChannelId: publicChannelID,
		UserId:    targetID,
	}))
	if err != nil {
		t.Fatalf("RemoveChannelMember (public): %v", err)
	}
}

// --- ListChannelMembers tests ---

func TestListChannelMembersSuccess(t *testing.T) {
	client, serverID, channelID, ownerID, chatStore, _ := setupChannelMemberScenario(t)

	// Add two members to the channel (owner was auto-added when creating the private channel).
	user1 := models.NewID()
	user2 := models.NewID()
	chatStore.AddMember(context.Background(), user1, serverID)
	chatStore.AddMember(context.Background(), user2, serverID)
	chatStore.AddChannelMember(context.Background(), channelID, user1)
	chatStore.AddChannelMember(context.Background(), channelID, user2)

	resp, err := client.ListChannelMembers(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.ListChannelMembersRequest{
		ChannelId: channelID,
	}))
	if err != nil {
		t.Fatalf("ListChannelMembers: %v", err)
	}
	// 3 members: owner (auto-added on private channel creation) + user1 + user2.
	if len(resp.Msg.Members) != 3 {
		t.Errorf("members count = %d, want 3", len(resp.Msg.Members))
	}
}

func TestListChannelMembersNotInChannel(t *testing.T) {
	client, serverID, channelID, _, chatStore, _ := setupChannelMemberScenario(t)

	// A server member who is NOT a channel member and is NOT the owner/admin.
	outsiderID := models.NewID()
	chatStore.AddMember(context.Background(), outsiderID, serverID)

	_, err := client.ListChannelMembers(context.Background(), testutil.AuthedRequest(t, outsiderID, &v1.ListChannelMembersRequest{
		ChannelId: channelID,
	}))
	if err == nil {
		t.Fatal("expected error for non-channel-member")
	}
	if connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Errorf("code = %v, want PermissionDenied", connect.CodeOf(err))
	}
}

func TestListChannelMembersNotServerMember(t *testing.T) {
	client, _, channelID, _, _, _ := setupChannelMemberScenario(t)

	outsiderID := models.NewID()
	_, err := client.ListChannelMembers(context.Background(), testutil.AuthedRequest(t, outsiderID, &v1.ListChannelMembersRequest{
		ChannelId: channelID,
	}))
	if err == nil {
		t.Fatal("expected error for non-server-member")
	}
	if connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Errorf("code = %v, want PermissionDenied", connect.CodeOf(err))
	}
}
