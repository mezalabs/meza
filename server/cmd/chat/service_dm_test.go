package main

import (
	"context"
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
	"github.com/mezalabs/meza/internal/store"
	"github.com/mezalabs/meza/internal/testutil"
)

// ---------- mock AuthStorer for DM tests ----------

type dmMockAuthStore struct {
	mu    sync.Mutex
	users map[string]*models.User
}

func newDMMockAuthStore() *dmMockAuthStore {
	return &dmMockAuthStore{users: make(map[string]*models.User)}
}

func (s *dmMockAuthStore) addUser(u *models.User) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.users[u.ID] = u
}

func (s *dmMockAuthStore) GetUserByID(_ context.Context, userID string) (*models.User, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if u, ok := s.users[userID]; ok {
		return u, nil
	}
	return nil, pgx.ErrNoRows
}

func (s *dmMockAuthStore) CreateUser(context.Context, *models.User, string, []byte, models.EncryptedBundle) (*models.User, error) {
	return nil, nil
}
func (s *dmMockAuthStore) GetUsersByIDs(context.Context, []string) ([]*models.User, error) {
	return nil, nil
}
func (s *dmMockAuthStore) UpdateUser(context.Context, store.UpdateUserParams) (*models.User, error) {
	return nil, nil
}
func (s *dmMockAuthStore) GetAuthDataByUserID(context.Context, string) (*models.AuthData, error) {
	return nil, nil
}
func (s *dmMockAuthStore) GetUserByEmail(context.Context, string) (*models.User, *models.AuthData, error) {
	return nil, nil, nil
}
func (s *dmMockAuthStore) GetUserByUsername(context.Context, string) (*models.User, *models.AuthData, error) {
	return nil, nil, nil
}
func (s *dmMockAuthStore) GetSalt(context.Context, string) ([]byte, error) { return nil, nil }
func (s *dmMockAuthStore) GetSaltByUsername(context.Context, string) ([]byte, error) {
	return nil, nil
}
func (s *dmMockAuthStore) StoreRefreshToken(context.Context, string, string, string, time.Time) error {
	return nil
}
func (s *dmMockAuthStore) ConsumeRefreshToken(context.Context, string) (string, string, error) {
	return "", "", nil
}
func (s *dmMockAuthStore) DeleteRefreshTokensByUser(context.Context, string) error { return nil }
func (s *dmMockAuthStore) DeleteRefreshTokensByDevice(context.Context, string, string) error {
	return nil
}
func (s *dmMockAuthStore) GetKeyBundle(context.Context, string) (*models.EncryptedBundle, error) {
	return nil, nil
}
func (s *dmMockAuthStore) ChangePassword(context.Context, string, string, string, []byte, models.EncryptedBundle) error {
	return nil
}
func (s *dmMockAuthStore) GetRecoveryBundle(context.Context, string) ([]byte, []byte, []byte, error) {
	return nil, nil, nil, nil
}
func (s *dmMockAuthStore) RecoverAccount(context.Context, string, string, []byte, models.EncryptedBundle, func([]byte) bool, ...string) (string, error) {
	return "", nil
}

// ---------- mock ChatStorer for DM tests (extends base mock) ----------

type dmMockChatStore struct {
	mockChatStore
	dmChannels    map[string]*models.Channel // pairKey -> channel
	dmMembers     map[string][]string        // channelID -> []userID
	dmMu          sync.Mutex
}

func newDMMockChatStore(rs *mockRoleStore) *dmMockChatStore {
	return &dmMockChatStore{
		mockChatStore: *newMockChatStore(rs),
		dmChannels:    make(map[string]*models.Channel),
		dmMembers:     make(map[string][]string),
	}
}

func (m *dmMockChatStore) CreateDMChannel(_ context.Context, userID1, userID2, dmStatus, dmInitiatorID string) (*models.Channel, bool, error) {
	m.dmMu.Lock()
	defer m.dmMu.Unlock()

	pairKey := dmPairKeyForTest(userID1, userID2)
	if ch, ok := m.dmChannels[pairKey]; ok {
		return ch, false, nil
	}

	ch := &models.Channel{
		ID:            models.NewID(),
		Name:          "dm",
		Type:          3,
		IsPrivate:     true,
		DMStatus:      dmStatus,
		DMInitiatorID: dmInitiatorID,
		CreatedAt:     time.Now(),
	}
	m.dmChannels[pairKey] = ch

	// Track members.
	if userID1 == userID2 {
		m.dmMembers[ch.ID] = []string{userID1}
	} else {
		m.dmMembers[ch.ID] = []string{userID1, userID2}
	}

	return ch, true, nil
}

func (m *dmMockChatStore) GetDMChannelByPairKey(_ context.Context, userID1, userID2 string) (*models.Channel, error) {
	m.dmMu.Lock()
	defer m.dmMu.Unlock()

	pairKey := dmPairKeyForTest(userID1, userID2)
	if ch, ok := m.dmChannels[pairKey]; ok {
		return ch, nil
	}
	return nil, nil
}

func (m *dmMockChatStore) GetDMOtherParticipantID(_ context.Context, channelID, userID string) (string, error) {
	m.dmMu.Lock()
	defer m.dmMu.Unlock()

	members := m.dmMembers[channelID]
	for _, uid := range members {
		if uid != userID {
			return uid, nil
		}
	}
	// Self-DM: return the caller's own ID.
	return userID, nil
}

func dmPairKeyForTest(a, b string) string {
	if a < b {
		return a + ":" + b
	}
	return b + ":" + a
}

// ---------- mock BlockStorer for DM tests ----------

type dmMockBlockStore struct {
	mu      sync.Mutex
	blocked map[string]bool
}

func newDMMockBlockStore() *dmMockBlockStore {
	return &dmMockBlockStore{blocked: make(map[string]bool)}
}

func (b *dmMockBlockStore) BlockUser(_ context.Context, blockerID, blockedID string) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.blocked[blockerID+":"+blockedID] = true
	return nil
}
func (b *dmMockBlockStore) BlockUserTx(_ context.Context, _ pgx.Tx, _, _ string) error {
	return nil
}
func (b *dmMockBlockStore) UnblockUser(context.Context, string, string) error { return nil }
func (b *dmMockBlockStore) IsBlockedEither(_ context.Context, userA, userB string) (bool, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.blocked[userA+":"+userB] || b.blocked[userB+":"+userA], nil
}
func (b *dmMockBlockStore) ListBlocks(context.Context, string) ([]string, error) { return nil, nil }
func (b *dmMockBlockStore) ListBlocksWithUsers(context.Context, string) ([]*models.User, error) {
	return nil, nil
}

// ---------- mock FriendStorer for DM tests ----------

type dmMockFriendStore struct{}

func (s *dmMockFriendStore) SendFriendRequest(context.Context, string, string) (bool, error) {
	return false, nil
}
func (s *dmMockFriendStore) AcceptFriendRequest(context.Context, string, string) error { return nil }
func (s *dmMockFriendStore) DeclineFriendRequest(context.Context, string, string) error {
	return nil
}
func (s *dmMockFriendStore) CancelFriendRequest(context.Context, string, string) error { return nil }
func (s *dmMockFriendStore) RemoveFriend(context.Context, string, string) error       { return nil }
func (s *dmMockFriendStore) AreFriends(context.Context, string, string) (bool, error) {
	return false, nil
}
func (s *dmMockFriendStore) ListFriendsWithUsers(context.Context, string) ([]*models.User, error) {
	return nil, nil
}
func (s *dmMockFriendStore) ListIncomingRequestsWithUsers(context.Context, string) ([]*models.FriendRequest, error) {
	return nil, nil
}
func (s *dmMockFriendStore) ListOutgoingRequestsWithUsers(context.Context, string) ([]*models.FriendRequest, error) {
	return nil, nil
}
func (s *dmMockFriendStore) CountPendingOutgoingRequests(context.Context, string) (int, error) {
	return 0, nil
}
func (s *dmMockFriendStore) RemoveFriendshipsByUser(context.Context, string, string) error {
	return nil
}
func (s *dmMockFriendStore) RemoveFriendshipsByUserTx(_ context.Context, _ pgx.Tx, _, _ string) error {
	return nil
}
func (s *dmMockFriendStore) GetMutualFriends(context.Context, string, string) ([]*models.User, error) {
	return nil, nil
}

// ---------- test setup ----------

type dmTestEnv struct {
	client     mezav1connect.ChatServiceClient
	chatStore  *dmMockChatStore
	authStore  *dmMockAuthStore
	blockStore *dmMockBlockStore
}

func setupDMTestServer(t *testing.T) *dmTestEnv {
	t.Helper()

	roleStore := newMockRoleStore()
	chatStore := newDMMockChatStore(roleStore)
	messageStore := newMockMessageStore()
	inviteStore := newMockInviteStore()
	banStore := newMockBanStore()
	pinStore := newMockPinStore()
	emojiStore := &mockEmojiStore{}
	authStore := newDMMockAuthStore()
	blockStore := newDMMockBlockStore()
	friendStore := &dmMockFriendStore{}
	nc := testutil.StartTestNATS(t)

	svc := newChatService(chatServiceConfig{
		ChatStore:               chatStore,
		MessageStore:            messageStore,
		InviteStore:             inviteStore,
		RoleStore:               roleStore,
		BanStore:                banStore,
		PinStore:                pinStore,
		EmojiStore:              emojiStore,
		AuthStore:               authStore,
		BlockStore:              blockStore,
		FriendStore:             friendStore,
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
	return &dmTestEnv{
		client:     client,
		chatStore:  chatStore,
		authStore:  authStore,
		blockStore: blockStore,
	}
}

// ---------- tests ----------

func TestCreateSelfDM(t *testing.T) {
	env := setupDMTestServer(t)
	userID := models.NewID()

	env.authStore.addUser(&models.User{
		ID:       userID,
		Username: "alice",
	})

	resp, err := env.client.CreateOrGetDMChannel(context.Background(), testutil.AuthedRequest(t, userID, &v1.CreateOrGetDMChannelRequest{
		RecipientId: userID,
	}))
	if err != nil {
		t.Fatalf("CreateOrGetDMChannel (self): %v", err)
	}
	if resp.Msg.DmChannel == nil {
		t.Fatal("expected dm_channel in response")
	}
	if !resp.Msg.Created {
		t.Error("expected created = true for first self-DM")
	}

	// Should have exactly 1 participant (deduplicated).
	if len(resp.Msg.DmChannel.Participants) != 1 {
		t.Errorf("participants = %d, want 1", len(resp.Msg.DmChannel.Participants))
	}
	if resp.Msg.DmChannel.Participants[0].Id != userID {
		t.Errorf("participant ID = %q, want %q", resp.Msg.DmChannel.Participants[0].Id, userID)
	}

	// Channel should be active.
	if resp.Msg.DmChannel.Channel.GetDmStatus() != "active" {
		t.Errorf("dm_status = %q, want %q", resp.Msg.DmChannel.Channel.GetDmStatus(), "active")
	}
}

func TestCreateSelfDMIdempotent(t *testing.T) {
	env := setupDMTestServer(t)
	userID := models.NewID()

	env.authStore.addUser(&models.User{
		ID:       userID,
		Username: "alice",
	})

	// Create first time.
	resp1, err := env.client.CreateOrGetDMChannel(context.Background(), testutil.AuthedRequest(t, userID, &v1.CreateOrGetDMChannelRequest{
		RecipientId: userID,
	}))
	if err != nil {
		t.Fatalf("first CreateOrGetDMChannel (self): %v", err)
	}
	if !resp1.Msg.Created {
		t.Error("expected created = true on first call")
	}

	// Call again — should return existing.
	resp2, err := env.client.CreateOrGetDMChannel(context.Background(), testutil.AuthedRequest(t, userID, &v1.CreateOrGetDMChannelRequest{
		RecipientId: userID,
	}))
	if err != nil {
		t.Fatalf("second CreateOrGetDMChannel (self): %v", err)
	}
	if resp2.Msg.Created {
		t.Error("expected created = false on second call")
	}
	if resp2.Msg.DmChannel.Channel.Id != resp1.Msg.DmChannel.Channel.Id {
		t.Errorf("channel IDs differ: %q vs %q", resp2.Msg.DmChannel.Channel.Id, resp1.Msg.DmChannel.Channel.Id)
	}
}

func TestCreateDMWithSystemUserBlocked(t *testing.T) {
	env := setupDMTestServer(t)
	userID := models.NewID()

	env.authStore.addUser(&models.User{
		ID:       userID,
		Username: "alice",
	})

	_, err := env.client.CreateOrGetDMChannel(context.Background(), testutil.AuthedRequest(t, userID, &v1.CreateOrGetDMChannelRequest{
		RecipientId: models.SystemUserID,
	}))
	if err == nil {
		t.Fatal("expected error when creating DM with system user")
	}
	if connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Errorf("code = %v, want InvalidArgument", connect.CodeOf(err))
	}
}

func TestBlockSystemUserBlocked(t *testing.T) {
	env := setupDMTestServer(t)
	userID := models.NewID()

	_, err := env.client.BlockUser(context.Background(), testutil.AuthedRequest(t, userID, &v1.BlockUserRequest{
		UserId: models.SystemUserID,
	}))
	if err == nil {
		t.Fatal("expected error when blocking system user")
	}
	if connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Errorf("code = %v, want InvalidArgument", connect.CodeOf(err))
	}
}
