package main

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/jackc/pgx/v5"

	v1 "github.com/mezalabs/meza/gen/meza/v1"
	"github.com/mezalabs/meza/gen/meza/v1/mezav1connect"
	"github.com/mezalabs/meza/internal/auth"
	"github.com/mezalabs/meza/internal/models"
	"github.com/mezalabs/meza/internal/permissions"
	"github.com/mezalabs/meza/internal/testutil"
)

// ---------- mock FriendStorer for profile tests ----------

type profileMockFriendStore struct {
	mu      sync.Mutex
	friends map[string][]*models.User // userID -> mutual friends
}

func newProfileMockFriendStore() *profileMockFriendStore {
	return &profileMockFriendStore{
		friends: make(map[string][]*models.User),
	}
}

func (s *profileMockFriendStore) setMutualFriends(userID1, userID2 string, friends []*models.User) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.friends[userID1+":"+userID2] = friends
	s.friends[userID2+":"+userID1] = friends
}

func (s *profileMockFriendStore) GetMutualFriends(_ context.Context, userID1, userID2 string) ([]*models.User, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.friends[userID1+":"+userID2], nil
}

func (s *profileMockFriendStore) SendFriendRequest(context.Context, string, string) (bool, error) {
	return false, nil
}
func (s *profileMockFriendStore) AcceptFriendRequest(context.Context, string, string) error {
	return nil
}
func (s *profileMockFriendStore) DeclineFriendRequest(context.Context, string, string) error {
	return nil
}
func (s *profileMockFriendStore) CancelFriendRequest(context.Context, string, string) error {
	return nil
}
func (s *profileMockFriendStore) RemoveFriend(context.Context, string, string) error { return nil }
func (s *profileMockFriendStore) AreFriends(context.Context, string, string) (bool, error) {
	return false, nil
}
func (s *profileMockFriendStore) ListFriendsWithUsers(context.Context, string) ([]*models.User, error) {
	return nil, nil
}
func (s *profileMockFriendStore) ListIncomingRequestsWithUsers(context.Context, string) ([]*models.FriendRequest, error) {
	return nil, nil
}
func (s *profileMockFriendStore) ListOutgoingRequestsWithUsers(context.Context, string) ([]*models.FriendRequest, error) {
	return nil, nil
}
func (s *profileMockFriendStore) CountPendingOutgoingRequests(context.Context, string) (int, error) {
	return 0, nil
}
func (s *profileMockFriendStore) RemoveFriendshipsByUser(context.Context, string, string) error {
	return nil
}
func (s *profileMockFriendStore) RemoveFriendshipsByUserTx(_ context.Context, _ pgx.Tx, _, _ string) error {
	return nil
}

// ---------- mock BlockStorer for profile tests ----------

type profileMockBlockStore struct {
	mu      sync.Mutex
	blocked map[string]bool // "userA:userB" -> true
}

func newProfileMockBlockStore() *profileMockBlockStore {
	return &profileMockBlockStore{blocked: make(map[string]bool)}
}

func (b *profileMockBlockStore) BlockUser(_ context.Context, blockerID, blockedID string) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.blocked[blockerID+":"+blockedID] = true
	return nil
}
func (b *profileMockBlockStore) BlockUserTx(_ context.Context, _ pgx.Tx, _, _ string) error {
	return nil
}
func (b *profileMockBlockStore) UnblockUser(context.Context, string, string) error { return nil }
func (b *profileMockBlockStore) IsBlockedEither(_ context.Context, userA, userB string) (bool, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.blocked[userA+":"+userB] || b.blocked[userB+":"+userA], nil
}
func (b *profileMockBlockStore) ListBlocks(context.Context, string) ([]string, error) {
	return nil, nil
}
func (b *profileMockBlockStore) ListBlocksWithUsers(context.Context, string) ([]*models.User, error) {
	return nil, nil
}

// ---------- test setup ----------

type profileTestEnv struct {
	client      mezav1connect.ChatServiceClient
	chatStore   *mockChatStore
	friendStore *profileMockFriendStore
	blockStore  *profileMockBlockStore
}

func setupProfileTestServer(t *testing.T) *profileTestEnv {
	t.Helper()

	roleStore := newMockRoleStore()
	chatStore := newMockChatStore(roleStore)
	messageStore := newMockMessageStore()
	inviteStore := newMockInviteStore()
	banStore := newMockBanStore()
	pinStore := newMockPinStore()
	emojiStore := &mockEmojiStore{}
	friendStore := newProfileMockFriendStore()
	blockStore := newProfileMockBlockStore()
	nc := testutil.StartTestNATS(t)

	svc := newChatService(chatServiceConfig{
		ChatStore:               chatStore,
		MessageStore:            messageStore,
		InviteStore:             inviteStore,
		RoleStore:               roleStore,
		BanStore:                banStore,
		PinStore:                pinStore,
		EmojiStore:              emojiStore,
		FriendStore:             friendStore,
		BlockStore:              blockStore,
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
	return &profileTestEnv{
		client:      client,
		chatStore:   chatStore,
		friendStore: friendStore,
		blockStore:  blockStore,
	}
}

// ================================================================
// GetMutualServers tests
// ================================================================

func TestGetMutualServers_Unauthenticated(t *testing.T) {
	env := setupProfileTestServer(t)

	_, err := env.client.GetMutualServers(context.Background(), connect.NewRequest(&v1.GetMutualServersRequest{
		UserId: models.NewID(),
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

func TestGetMutualServers_MissingUserID(t *testing.T) {
	env := setupProfileTestServer(t)
	callerID := models.NewID()

	_, err := env.client.GetMutualServers(context.Background(), testutil.AuthedRequest(t, callerID, &v1.GetMutualServersRequest{
		UserId: "",
	}))
	if err == nil {
		t.Fatal("expected error for missing user_id, got nil")
	}
	if connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Errorf("code = %v, want %v", connect.CodeOf(err), connect.CodeInvalidArgument)
	}
}

func TestGetMutualServers_SelfReturnsEmpty(t *testing.T) {
	env := setupProfileTestServer(t)
	callerID := models.NewID()

	resp, err := env.client.GetMutualServers(context.Background(), testutil.AuthedRequest(t, callerID, &v1.GetMutualServersRequest{
		UserId: callerID,
	}))
	if err != nil {
		t.Fatalf("GetMutualServers: %v", err)
	}
	if len(resp.Msg.Servers) != 0 {
		t.Errorf("expected 0 servers for self lookup, got %d", len(resp.Msg.Servers))
	}
}

func TestGetMutualServers_BlockedReturnsEmpty(t *testing.T) {
	env := setupProfileTestServer(t)
	callerID := models.NewID()
	targetID := models.NewID()
	serverID := models.NewID()

	// Create a mutual server.
	env.chatStore.CreateServer(context.Background(), "Mutual", callerID, nil, false)
	// Manually add the target to the server too.
	env.chatStore.mu.Lock()
	// Find the server by name since CreateServer assigns a random ID.
	var srvID string
	for id, srv := range env.chatStore.servers {
		if srv.Name == "Mutual" {
			srvID = id
			break
		}
	}
	env.chatStore.mu.Unlock()
	if srvID == "" {
		srvID = serverID
	}
	env.chatStore.AddMember(context.Background(), targetID, srvID)

	// Block the target.
	env.blockStore.blocked[callerID+":"+targetID] = true

	resp, err := env.client.GetMutualServers(context.Background(), testutil.AuthedRequest(t, callerID, &v1.GetMutualServersRequest{
		UserId: targetID,
	}))
	if err != nil {
		t.Fatalf("GetMutualServers: %v", err)
	}
	if len(resp.Msg.Servers) != 0 {
		t.Errorf("expected 0 servers for blocked user, got %d", len(resp.Msg.Servers))
	}
}

func TestGetMutualServers_HappyPath(t *testing.T) {
	env := setupProfileTestServer(t)
	callerID := models.NewID()
	targetID := models.NewID()

	srv, _ := env.chatStore.CreateServer(context.Background(), "Shared Guild", callerID, nil, false)
	env.chatStore.AddMember(context.Background(), targetID, srv.ID)

	resp, err := env.client.GetMutualServers(context.Background(), testutil.AuthedRequest(t, callerID, &v1.GetMutualServersRequest{
		UserId: targetID,
	}))
	if err != nil {
		t.Fatalf("GetMutualServers: %v", err)
	}
	if len(resp.Msg.Servers) != 1 {
		t.Fatalf("expected 1 mutual server, got %d", len(resp.Msg.Servers))
	}
	if resp.Msg.Servers[0].Name != "Shared Guild" {
		t.Errorf("server name = %q, want %q", resp.Msg.Servers[0].Name, "Shared Guild")
	}
}

func TestGetMutualServers_NoMutualReturnsEmpty(t *testing.T) {
	env := setupProfileTestServer(t)
	callerID := models.NewID()
	targetID := models.NewID()

	// Caller has a server, target does not.
	env.chatStore.CreateServer(context.Background(), "CallerOnly", callerID, nil, false)

	resp, err := env.client.GetMutualServers(context.Background(), testutil.AuthedRequest(t, callerID, &v1.GetMutualServersRequest{
		UserId: targetID,
	}))
	if err != nil {
		t.Fatalf("GetMutualServers: %v", err)
	}
	if len(resp.Msg.Servers) != 0 {
		t.Errorf("expected 0 mutual servers, got %d", len(resp.Msg.Servers))
	}
}

// ================================================================
// GetMutualFriends tests
// ================================================================

func TestGetMutualFriends_Unauthenticated(t *testing.T) {
	env := setupProfileTestServer(t)

	_, err := env.client.GetMutualFriends(context.Background(), connect.NewRequest(&v1.GetMutualFriendsRequest{
		UserId: models.NewID(),
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

func TestGetMutualFriends_MissingUserID(t *testing.T) {
	env := setupProfileTestServer(t)
	callerID := models.NewID()

	_, err := env.client.GetMutualFriends(context.Background(), testutil.AuthedRequest(t, callerID, &v1.GetMutualFriendsRequest{
		UserId: "",
	}))
	if err == nil {
		t.Fatal("expected error for missing user_id, got nil")
	}
	if connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Errorf("code = %v, want %v", connect.CodeOf(err), connect.CodeInvalidArgument)
	}
}

func TestGetMutualFriends_SelfReturnsEmpty(t *testing.T) {
	env := setupProfileTestServer(t)
	callerID := models.NewID()

	resp, err := env.client.GetMutualFriends(context.Background(), testutil.AuthedRequest(t, callerID, &v1.GetMutualFriendsRequest{
		UserId: callerID,
	}))
	if err != nil {
		t.Fatalf("GetMutualFriends: %v", err)
	}
	if len(resp.Msg.Users) != 0 {
		t.Errorf("expected 0 users for self lookup, got %d", len(resp.Msg.Users))
	}
}

func TestGetMutualFriends_BlockedReturnsEmpty(t *testing.T) {
	env := setupProfileTestServer(t)
	callerID := models.NewID()
	targetID := models.NewID()

	// Set up mutual friends.
	mutualUser := &models.User{
		ID: models.NewID(), Username: "mutual-friend", CreatedAt: time.Now(),
		DMPrivacy: "friends_and_servers",
	}
	env.friendStore.setMutualFriends(callerID, targetID, []*models.User{mutualUser})

	// Block the target.
	env.blockStore.blocked[callerID+":"+targetID] = true

	resp, err := env.client.GetMutualFriends(context.Background(), testutil.AuthedRequest(t, callerID, &v1.GetMutualFriendsRequest{
		UserId: targetID,
	}))
	if err != nil {
		t.Fatalf("GetMutualFriends: %v", err)
	}
	if len(resp.Msg.Users) != 0 {
		t.Errorf("expected 0 users for blocked lookup, got %d", len(resp.Msg.Users))
	}
}

func TestGetMutualFriends_HappyPath(t *testing.T) {
	env := setupProfileTestServer(t)
	callerID := models.NewID()
	targetID := models.NewID()

	mutualUser := &models.User{
		ID: models.NewID(), Username: "common-pal", CreatedAt: time.Now(),
		DMPrivacy: "friends_and_servers",
	}
	env.friendStore.setMutualFriends(callerID, targetID, []*models.User{mutualUser})

	resp, err := env.client.GetMutualFriends(context.Background(), testutil.AuthedRequest(t, callerID, &v1.GetMutualFriendsRequest{
		UserId: targetID,
	}))
	if err != nil {
		t.Fatalf("GetMutualFriends: %v", err)
	}
	if len(resp.Msg.Users) != 1 {
		t.Fatalf("expected 1 mutual friend, got %d", len(resp.Msg.Users))
	}
	if resp.Msg.Users[0].Username != "common-pal" {
		t.Errorf("username = %q, want %q", resp.Msg.Users[0].Username, "common-pal")
	}
	// DmPrivacy should be stripped from response.
	if resp.Msg.Users[0].DmPrivacy != "" {
		t.Errorf("DmPrivacy = %q, want empty (should be stripped)", resp.Msg.Users[0].DmPrivacy)
	}
}

func TestGetMutualFriends_NoMutualReturnsEmpty(t *testing.T) {
	env := setupProfileTestServer(t)
	callerID := models.NewID()
	targetID := models.NewID()

	// Don't set up any mutual friends.
	resp, err := env.client.GetMutualFriends(context.Background(), testutil.AuthedRequest(t, callerID, &v1.GetMutualFriendsRequest{
		UserId: targetID,
	}))
	if err != nil {
		t.Fatalf("GetMutualFriends: %v", err)
	}
	if len(resp.Msg.Users) != 0 {
		t.Errorf("expected 0 mutual friends, got %d", len(resp.Msg.Users))
	}
}
