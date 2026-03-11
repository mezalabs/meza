package main

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"connectrpc.com/connect"
	v1 "github.com/mezalabs/meza/gen/meza/v1"
	"github.com/mezalabs/meza/gen/meza/v1/mezav1connect"
	"github.com/mezalabs/meza/internal/auth"
	"github.com/mezalabs/meza/internal/models"
	"github.com/mezalabs/meza/internal/permissions"
	"github.com/mezalabs/meza/internal/store"
	"github.com/mezalabs/meza/internal/testutil"
	"github.com/jackc/pgx/v5"
)

// ---------------------------------------------------------------------------
// Minimal mock stores for IDOR tests (only methods exercised by tested RPCs).
// ---------------------------------------------------------------------------

// idorMockReactionStore implements store.ReactionStorer for IDOR testing.
type idorMockReactionStore struct {
	mu        sync.Mutex
	reactions map[string][]*models.Reaction // key: "channelID:messageID" -> reactions
}

func newIDORMockReactionStore() *idorMockReactionStore {
	return &idorMockReactionStore{reactions: make(map[string][]*models.Reaction)}
}

func (s *idorMockReactionStore) AddReaction(_ context.Context, r *models.Reaction) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := r.ChannelID + ":" + r.MessageID
	s.reactions[key] = append(s.reactions[key], r)
	return nil
}

func (s *idorMockReactionStore) RemoveReaction(_ context.Context, channelID, messageID, userID, emoji string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := channelID + ":" + messageID
	var kept []*models.Reaction
	for _, r := range s.reactions[key] {
		if !(r.UserID == userID && r.Emoji == emoji) {
			kept = append(kept, r)
		}
	}
	s.reactions[key] = kept
	return nil
}

func (s *idorMockReactionStore) GetReactionGroups(_ context.Context, channelID string, messageIDs []string, callerID string) (map[string][]*models.ReactionGroup, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	result := make(map[string][]*models.ReactionGroup)
	for _, msgID := range messageIDs {
		key := channelID + ":" + msgID
		emojiMap := make(map[string]*models.ReactionGroup)
		for _, r := range s.reactions[key] {
			if g, ok := emojiMap[r.Emoji]; ok {
				g.UserIDs = append(g.UserIDs, r.UserID)
				if r.UserID == callerID {
					g.Me = true
				}
			} else {
				emojiMap[r.Emoji] = &models.ReactionGroup{
					Emoji:   r.Emoji,
					Me:      r.UserID == callerID,
					UserIDs: []string{r.UserID},
				}
			}
		}
		for _, g := range emojiMap {
			result[msgID] = append(result[msgID], g)
		}
	}
	return result, nil
}

func (s *idorMockReactionStore) CountUniqueEmojis(_ context.Context, channelID, messageID string) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := channelID + ":" + messageID
	emojis := make(map[string]bool)
	for _, r := range s.reactions[key] {
		emojis[r.Emoji] = true
	}
	return len(emojis), nil
}

func (s *idorMockReactionStore) RemoveAllMessageReactions(context.Context, string, string) error {
	return nil
}

// idorMockReadStateStore implements store.ReadStateStorer for IDOR testing.
type idorMockReadStateStore struct {
	mu     sync.Mutex
	states map[string]string // key: "userID:channelID" -> lastReadMessageID
}

func newIDORMockReadStateStore() *idorMockReadStateStore {
	return &idorMockReadStateStore{states: make(map[string]string)}
}

func (s *idorMockReadStateStore) UpsertReadState(_ context.Context, userID, channelID, messageID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := userID + ":" + channelID
	s.states[key] = messageID
	return nil
}

func (s *idorMockReadStateStore) GetReadState(_ context.Context, userID, channelID string) (*models.ReadState, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := userID + ":" + channelID
	msgID, ok := s.states[key]
	if !ok {
		return nil, nil
	}
	return &models.ReadState{UserID: userID, ChannelID: channelID, LastReadMessageID: msgID}, nil
}

func (s *idorMockReadStateStore) GetReadStates(_ context.Context, userID string) ([]models.ReadState, error) {
	return nil, nil
}

func (s *idorMockReadStateStore) MarkServerAsRead(_ context.Context, _ string, _ []string, _ []string) error {
	return nil
}

// idorMockFriendStore implements store.FriendStorer for IDOR testing.
// Tracks pending requests as requesterID -> addresseeID pairs.
type idorMockFriendStore struct {
	mu       sync.Mutex
	pending  map[string]string // "requesterID:addresseeID" -> "pending"
	accepted map[string]bool   // "requesterID:addresseeID" -> true
}

func newIDORMockFriendStore() *idorMockFriendStore {
	return &idorMockFriendStore{
		pending:  make(map[string]string),
		accepted: make(map[string]bool),
	}
}

func (s *idorMockFriendStore) addPendingRequest(requesterID, addresseeID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.pending[requesterID+":"+addresseeID] = "pending"
}

func (s *idorMockFriendStore) SendFriendRequest(_ context.Context, requesterID, addresseeID string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.pending[requesterID+":"+addresseeID] = "pending"
	return false, nil
}

func (s *idorMockFriendStore) AcceptFriendRequest(_ context.Context, addresseeID, requesterID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := requesterID + ":" + addresseeID
	if _, ok := s.pending[key]; !ok {
		return store.ErrNotFound
	}
	delete(s.pending, key)
	s.accepted[key] = true
	return nil
}

func (s *idorMockFriendStore) DeclineFriendRequest(_ context.Context, addresseeID, requesterID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := requesterID + ":" + addresseeID
	if _, ok := s.pending[key]; !ok {
		return store.ErrNotFound
	}
	delete(s.pending, key)
	return nil
}

func (s *idorMockFriendStore) CancelFriendRequest(_ context.Context, requesterID, addresseeID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := requesterID + ":" + addresseeID
	if _, ok := s.pending[key]; !ok {
		return store.ErrNotFound
	}
	delete(s.pending, key)
	return nil
}

func (s *idorMockFriendStore) RemoveFriend(context.Context, string, string) error {
	return nil
}

func (s *idorMockFriendStore) AreFriends(context.Context, string, string) (bool, error) {
	return false, nil
}

func (s *idorMockFriendStore) ListFriendsWithUsers(context.Context, string) ([]*models.User, error) {
	return nil, nil
}

func (s *idorMockFriendStore) ListIncomingRequestsWithUsers(context.Context, string) ([]*models.FriendRequest, error) {
	return nil, nil
}

func (s *idorMockFriendStore) ListOutgoingRequestsWithUsers(context.Context, string) ([]*models.FriendRequest, error) {
	return nil, nil
}

func (s *idorMockFriendStore) CountPendingOutgoingRequests(context.Context, string) (int, error) {
	return 0, nil
}

func (s *idorMockFriendStore) RemoveFriendshipsByUser(context.Context, string, string) error {
	return nil
}

func (s *idorMockFriendStore) RemoveFriendshipsByUserTx(_ context.Context, _ pgx.Tx, _, _ string) error {
	panic("not implemented")
}

func (s *idorMockFriendStore) GetMutualFriends(context.Context, string, string) ([]*models.User, error) {
	return nil, nil
}

// idorMockBlockStore implements store.BlockStorer for IDOR testing.
type idorMockBlockStore struct{}

func (s *idorMockBlockStore) BlockUser(context.Context, string, string) error { return nil }
func (s *idorMockBlockStore) BlockUserTx(_ context.Context, _ pgx.Tx, _, _ string) error {
	return nil
}
func (s *idorMockBlockStore) UnblockUser(context.Context, string, string) error { return nil }
func (s *idorMockBlockStore) IsBlockedEither(context.Context, string, string) (bool, error) {
	return false, nil
}
func (s *idorMockBlockStore) ListBlocks(context.Context, string) ([]string, error) {
	return nil, nil
}
func (s *idorMockBlockStore) ListBlocksWithUsers(context.Context, string) ([]*models.User, error) {
	return nil, nil
}

// idorMockSoundboardStore implements store.SoundboardStorer for IDOR testing.
type idorMockSoundboardStore struct {
	mu     sync.Mutex
	sounds map[string]*models.SoundboardSound
}

func newIDORMockSoundboardStore() *idorMockSoundboardStore {
	return &idorMockSoundboardStore{sounds: make(map[string]*models.SoundboardSound)}
}

func (s *idorMockSoundboardStore) CreateSound(_ context.Context, sound *models.SoundboardSound, _, _ int) (*models.SoundboardSound, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sounds[sound.ID] = sound
	return sound, nil
}

func (s *idorMockSoundboardStore) GetSound(_ context.Context, soundID string) (*models.SoundboardSound, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	snd, ok := s.sounds[soundID]
	if !ok {
		return nil, fmt.Errorf("not found")
	}
	return snd, nil
}

func (s *idorMockSoundboardStore) ListSoundsByUser(context.Context, string) ([]*models.SoundboardSound, error) {
	return nil, nil
}

func (s *idorMockSoundboardStore) ListSoundsByServer(_ context.Context, serverID string) ([]*models.SoundboardSound, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var result []*models.SoundboardSound
	for _, snd := range s.sounds {
		if snd.ServerID == serverID {
			result = append(result, snd)
		}
	}
	return result, nil
}

func (s *idorMockSoundboardStore) UpdateSound(_ context.Context, soundID, name string) (*models.SoundboardSound, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	snd, ok := s.sounds[soundID]
	if !ok {
		return nil, fmt.Errorf("not found")
	}
	snd.Name = name
	return snd, nil
}

func (s *idorMockSoundboardStore) DeleteSound(_ context.Context, soundID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.sounds, soundID)
	return nil
}

// idorMockAuthStore implements store.AuthStorer for IDOR testing (friend request needs GetUserByID).
type idorMockAuthStore struct {
	mu    sync.Mutex
	users map[string]*models.User
}

func newIDORMockAuthStore() *idorMockAuthStore {
	return &idorMockAuthStore{users: make(map[string]*models.User)}
}

func (s *idorMockAuthStore) addUser(u *models.User) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.users[u.ID] = u
}

func (s *idorMockAuthStore) GetUserByID(_ context.Context, userID string) (*models.User, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	u, ok := s.users[userID]
	if !ok {
		return nil, fmt.Errorf("user not found")
	}
	return u, nil
}

func (s *idorMockAuthStore) CreateUser(context.Context, *models.User, string, []byte, models.EncryptedBundle) (*models.User, error) {
	panic("not implemented")
}
func (s *idorMockAuthStore) UpdateUser(context.Context, string, *string, *string, *float32, *string, *string, *string, *string, *string, *bool, *models.AudioPreferences, *string, []models.UserConnection) (*models.User, error) {
	panic("not implemented")
}
func (s *idorMockAuthStore) GetAuthDataByUserID(context.Context, string) (*models.AuthData, error) {
	panic("not implemented")
}
func (s *idorMockAuthStore) GetUserByEmail(context.Context, string) (*models.User, *models.AuthData, error) {
	panic("not implemented")
}
func (s *idorMockAuthStore) GetUserByUsername(context.Context, string) (*models.User, *models.AuthData, error) {
	panic("not implemented")
}
func (s *idorMockAuthStore) GetSalt(context.Context, string) ([]byte, error) {
	panic("not implemented")
}
func (s *idorMockAuthStore) GetSaltByUsername(context.Context, string) ([]byte, error) {
	panic("not implemented")
}
func (s *idorMockAuthStore) StoreRefreshToken(context.Context, string, string, string, time.Time) error {
	panic("not implemented")
}
func (s *idorMockAuthStore) ConsumeRefreshToken(context.Context, string) (string, string, error) {
	panic("not implemented")
}
func (s *idorMockAuthStore) DeleteRefreshTokensByUser(context.Context, string) error {
	panic("not implemented")
}
func (s *idorMockAuthStore) DeleteRefreshTokensByDevice(context.Context, string, string) error {
	panic("not implemented")
}
func (s *idorMockAuthStore) GetKeyBundle(context.Context, string) (*models.EncryptedBundle, error) {
	panic("not implemented")
}
func (s *idorMockAuthStore) ChangePassword(context.Context, string, string, string, []byte, models.EncryptedBundle) error {
	panic("not implemented")
}
func (s *idorMockAuthStore) GetRecoveryBundle(context.Context, string) ([]byte, []byte, []byte, error) {
	panic("not implemented")
}
func (s *idorMockAuthStore) RecoverAccount(context.Context, string, string, []byte, models.EncryptedBundle, func([]byte) bool, ...string) (string, error) {
	panic("not implemented")
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

type idorTestEnv struct {
	client         mezav1connect.ChatServiceClient
	chatStore      *mockChatStore
	messageStore   *mockMessageStore
	roleStore      *mockRoleStore
	reactionStore  *idorMockReactionStore
	readStateStore *idorMockReadStateStore
	friendStore    *idorMockFriendStore
	soundStore     *idorMockSoundboardStore
	emojiStore     *statefulMockEmojiStore
	authStore      *idorMockAuthStore
}

func setupIDORTestServer(t *testing.T) *idorTestEnv {
	t.Helper()

	roleStore := newMockRoleStore()
	chatStore := newMockChatStore(roleStore)
	messageStore := newMockMessageStore()
	inviteStore := newMockInviteStore()
	banStore := newMockBanStore()
	pinStore := newMockPinStore()
	reactionStore := newIDORMockReactionStore()
	readStateStore := newIDORMockReadStateStore()
	friendStore := newIDORMockFriendStore()
	blockStore := &idorMockBlockStore{}
	soundStore := newIDORMockSoundboardStore()
	emojiStore := newStatefulMockEmojiStore()
	authStore := newIDORMockAuthStore()
	nc := testutil.StartTestNATS(t)

	svc := newChatService(chatServiceConfig{
		ChatStore:               chatStore,
		MessageStore:            messageStore,
		InviteStore:             inviteStore,
		RoleStore:               roleStore,
		BanStore:                banStore,
		PinStore:                pinStore,
		EmojiStore:              emojiStore,
		SoundboardStore:         soundStore,
		ReactionStore:           reactionStore,
		ReadStateStore:          readStateStore,
		FriendStore:             friendStore,
		BlockStore:              blockStore,
		AuthStore:               authStore,
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
	return &idorTestEnv{
		client:         client,
		chatStore:      chatStore,
		messageStore:   messageStore,
		roleStore:      roleStore,
		reactionStore:  reactionStore,
		readStateStore: readStateStore,
		friendStore:    friendStore,
		soundStore:     soundStore,
		emojiStore:     emojiStore,
		authStore:      authStore,
	}
}

// createServerWithMember is a helper that creates a server, adds a member, and
// returns (serverID, channelID). The owner is automatically a member.
func createServerWithMember(t *testing.T, env *idorTestEnv, ownerID string) (serverID, channelID string) {
	t.Helper()
	srvResp, err := env.client.CreateServer(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.CreateServerRequest{Name: "Test Server"}))
	if err != nil {
		t.Fatalf("CreateServer: %v", err)
	}
	serverID = srvResp.Msg.Server.Id

	chResp, err := env.client.CreateChannel(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.CreateChannelRequest{
		ServerId: serverID,
		Name:     "general",
		Type:     v1.ChannelType_CHANNEL_TYPE_TEXT,
	}))
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	channelID = chResp.Msg.Channel.Id
	return serverID, channelID
}

// ---------------------------------------------------------------------------
// Reaction IDOR tests
// ---------------------------------------------------------------------------

// TestAddReaction_IDOR_NonMember verifies that a non-member of a server cannot
// add a reaction to a message in that server's channel.
func TestAddReaction_IDOR_NonMember(t *testing.T) {
	env := setupIDORTestServer(t)

	ownerID := models.NewID()
	outsiderID := models.NewID()
	_, channelID := createServerWithMember(t, env, ownerID)

	// Insert a message for the reaction target.
	msgID := models.NewID()
	env.messageStore.InsertMessage(context.Background(), &models.Message{
		ChannelID:        channelID,
		MessageID:        msgID,
		AuthorID:         ownerID,
		EncryptedContent: []byte("hello"),
		CreatedAt:        time.Now(),
	})

	// outsiderID is NOT a member.
	_, err := env.client.AddReaction(context.Background(), testutil.AuthedRequest(t, outsiderID, &v1.AddReactionRequest{
		ChannelId: channelID,
		MessageId: msgID,
		Emoji:     "👍",
	}))
	if err == nil {
		t.Fatal("expected error for non-member adding reaction")
	}
	if connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Errorf("code = %v, want PermissionDenied", connect.CodeOf(err))
	}
}

// TestRemoveReaction_IDOR_CanOnlyRemoveOwn verifies that RemoveReaction passes
// the caller's user ID to the store, so user-B's call only removes user-B's
// reaction — not user-A's.
func TestRemoveReaction_IDOR_CanOnlyRemoveOwn(t *testing.T) {
	env := setupIDORTestServer(t)

	ownerID := models.NewID()
	userB := models.NewID()
	serverID, channelID := createServerWithMember(t, env, ownerID)
	env.chatStore.AddMember(context.Background(), userB, serverID)

	msgID := models.NewID()
	env.messageStore.InsertMessage(context.Background(), &models.Message{
		ChannelID:        channelID,
		MessageID:        msgID,
		AuthorID:         ownerID,
		EncryptedContent: []byte("hello"),
		CreatedAt:        time.Now(),
	})

	// Owner adds a reaction.
	_, err := env.client.AddReaction(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.AddReactionRequest{
		ChannelId: channelID,
		MessageId: msgID,
		Emoji:     "👍",
	}))
	if err != nil {
		t.Fatalf("AddReaction (owner): %v", err)
	}

	// user-B tries to remove the same emoji — should succeed silently (removes
	// user-B's non-existent reaction, not owner's).
	_, err = env.client.RemoveReaction(context.Background(), testutil.AuthedRequest(t, userB, &v1.RemoveReactionRequest{
		ChannelId: channelID,
		MessageId: msgID,
		Emoji:     "👍",
	}))
	if err != nil {
		t.Fatalf("RemoveReaction (userB): %v", err)
	}

	// Verify owner's reaction still exists.
	key := channelID + ":" + msgID
	env.reactionStore.mu.Lock()
	reactions := env.reactionStore.reactions[key]
	env.reactionStore.mu.Unlock()

	found := false
	for _, r := range reactions {
		if r.UserID == ownerID && r.Emoji == "👍" {
			found = true
		}
	}
	if !found {
		t.Error("owner's reaction should still exist after user-B's RemoveReaction")
	}
}

// TestGetReactions_IDOR_NonMember verifies that a non-member cannot fetch
// reactions from a server channel. The handler uses requireMembership.
func TestGetReactions_IDOR_NonMember(t *testing.T) {
	env := setupIDORTestServer(t)

	ownerID := models.NewID()
	outsiderID := models.NewID()
	_, channelID := createServerWithMember(t, env, ownerID)

	_, err := env.client.GetReactions(context.Background(), testutil.AuthedRequest(t, outsiderID, &v1.GetReactionsRequest{
		ChannelId:  channelID,
		MessageIds: []string{models.NewID()},
	}))
	if err == nil {
		t.Fatal("expected error for non-member getting reactions")
	}
	if connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Errorf("code = %v, want PermissionDenied", connect.CodeOf(err))
	}
}

// ---------------------------------------------------------------------------
// Read State IDOR tests
// ---------------------------------------------------------------------------

// TestAckMessage_IDOR_NonMember verifies that a non-member cannot acknowledge
// messages in a server channel.
func TestAckMessage_IDOR_NonMember(t *testing.T) {
	env := setupIDORTestServer(t)

	ownerID := models.NewID()
	outsiderID := models.NewID()
	_, channelID := createServerWithMember(t, env, ownerID)

	_, err := env.client.AckMessage(context.Background(), testutil.AuthedRequest(t, outsiderID, &v1.AckMessageRequest{
		ChannelId: channelID,
		MessageId: models.NewID(),
	}))
	if err == nil {
		t.Fatal("expected error for non-member acking message")
	}
	if connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Errorf("code = %v, want PermissionDenied", connect.CodeOf(err))
	}
}

// TestAckMessage_IDOR_OnlyUpdatesCallerState verifies that when user-A acks a
// message, only user-A's read state is updated — not anyone else's.
func TestAckMessage_IDOR_OnlyUpdatesCallerState(t *testing.T) {
	env := setupIDORTestServer(t)

	ownerID := models.NewID()
	userB := models.NewID()
	serverID, channelID := createServerWithMember(t, env, ownerID)
	env.chatStore.AddMember(context.Background(), userB, serverID)

	msgID := models.NewID()

	// user-A acks the message.
	_, err := env.client.AckMessage(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.AckMessageRequest{
		ChannelId: channelID,
		MessageId: msgID,
	}))
	if err != nil {
		t.Fatalf("AckMessage (owner): %v", err)
	}

	// Verify: owner's read state is set.
	env.readStateStore.mu.Lock()
	ownerState := env.readStateStore.states[ownerID+":"+channelID]
	userBState := env.readStateStore.states[userB+":"+channelID]
	env.readStateStore.mu.Unlock()

	if ownerState != msgID {
		t.Errorf("owner read state = %q, want %q", ownerState, msgID)
	}
	if userBState != "" {
		t.Errorf("user-B read state = %q, want empty (should not be affected)", userBState)
	}
}

// ---------------------------------------------------------------------------
// Friend Request IDOR tests
// ---------------------------------------------------------------------------

// TestAcceptFriendRequest_IDOR_WrongAddressee verifies that user-C cannot accept
// a friend request addressed to user-B. The friend store's AcceptFriendRequest
// scopes by addressee_id, returning ErrNotFound when the caller is not the addressee.
func TestAcceptFriendRequest_IDOR_WrongAddressee(t *testing.T) {
	env := setupIDORTestServer(t)

	userA := models.NewID() // requester
	userB := models.NewID() // addressee
	userC := models.NewID() // attacker

	// Register all users so authStore lookups work.
	for _, u := range []string{userA, userB, userC} {
		env.authStore.addUser(&models.User{ID: u, Username: "user-" + u[:8], CreatedAt: time.Now()})
	}

	// user-A sends a friend request to user-B.
	env.friendStore.addPendingRequest(userA, userB)

	// user-C tries to accept user-B's incoming request — should fail.
	_, err := env.client.AcceptFriendRequest(context.Background(), testutil.AuthedRequest(t, userC, &v1.AcceptFriendRequestRequest{
		UserId: userA, // requester ID
	}))
	if err == nil {
		t.Fatal("expected error when wrong user accepts friend request")
	}
	// The handler wraps store errors as CodeInternal.
	if connect.CodeOf(err) != connect.CodeInternal {
		t.Errorf("code = %v, want Internal (from ErrNotFound in store)", connect.CodeOf(err))
	}

	// Verify the request is still pending (not accepted by user-C).
	env.friendStore.mu.Lock()
	_, stillPending := env.friendStore.pending[userA+":"+userB]
	env.friendStore.mu.Unlock()
	if !stillPending {
		t.Error("friend request should still be pending after unauthorized accept attempt")
	}
}

// TestDeclineFriendRequest_IDOR_WrongAddressee verifies that user-C cannot
// decline a friend request addressed to user-B.
func TestDeclineFriendRequest_IDOR_WrongAddressee(t *testing.T) {
	env := setupIDORTestServer(t)

	userA := models.NewID()
	userB := models.NewID()
	userC := models.NewID()

	for _, u := range []string{userA, userB, userC} {
		env.authStore.addUser(&models.User{ID: u, Username: "user-" + u[:8], CreatedAt: time.Now()})
	}

	env.friendStore.addPendingRequest(userA, userB)

	_, err := env.client.DeclineFriendRequest(context.Background(), testutil.AuthedRequest(t, userC, &v1.DeclineFriendRequestRequest{
		UserId: userA,
	}))
	if err == nil {
		t.Fatal("expected error when wrong user declines friend request")
	}
	if connect.CodeOf(err) != connect.CodeInternal {
		t.Errorf("code = %v, want Internal (from ErrNotFound in store)", connect.CodeOf(err))
	}

	env.friendStore.mu.Lock()
	_, stillPending := env.friendStore.pending[userA+":"+userB]
	env.friendStore.mu.Unlock()
	if !stillPending {
		t.Error("friend request should still be pending after unauthorized decline attempt")
	}
}

// TestCancelFriendRequest_IDOR_WrongRequester verifies that user-C cannot cancel
// a friend request sent by user-A. The CancelFriendRequest store method scopes
// by requester_id.
func TestCancelFriendRequest_IDOR_WrongRequester(t *testing.T) {
	env := setupIDORTestServer(t)

	userA := models.NewID()
	userB := models.NewID()
	userC := models.NewID()

	for _, u := range []string{userA, userB, userC} {
		env.authStore.addUser(&models.User{ID: u, Username: "user-" + u[:8], CreatedAt: time.Now()})
	}

	env.friendStore.addPendingRequest(userA, userB)

	// user-C tries to cancel user-A's outgoing request to user-B.
	_, err := env.client.CancelFriendRequest(context.Background(), testutil.AuthedRequest(t, userC, &v1.CancelFriendRequestRequest{
		UserId: userB, // addressee ID
	}))
	if err == nil {
		t.Fatal("expected error when wrong user cancels friend request")
	}
	if connect.CodeOf(err) != connect.CodeInternal {
		t.Errorf("code = %v, want Internal (from ErrNotFound in store)", connect.CodeOf(err))
	}

	env.friendStore.mu.Lock()
	_, stillPending := env.friendStore.pending[userA+":"+userB]
	env.friendStore.mu.Unlock()
	if !stillPending {
		t.Error("friend request should still be pending after unauthorized cancel attempt")
	}
}

// ---------------------------------------------------------------------------
// Soundboard IDOR tests
// ---------------------------------------------------------------------------

// TestDeleteSound_IDOR_OtherUsersPersonalSound verifies that user-B cannot delete
// user-A's personal sound. The handler checks sound.UserID != userID and returns
// CodeNotFound to avoid leaking existence.
func TestDeleteSound_IDOR_OtherUsersPersonalSound(t *testing.T) {
	env := setupIDORTestServer(t)

	userA := models.NewID()

	// Create a personal sound owned by user-A.
	soundID := models.NewID()
	env.soundStore.mu.Lock()
	env.soundStore.sounds[soundID] = &models.SoundboardSound{
		ID:           soundID,
		UserID:       userA,
		ServerID:     "", // personal sound (no server)
		Name:         "mysound",
		AttachmentID: models.NewID(),
		CreatedAt:    time.Now(),
	}
	env.soundStore.mu.Unlock()

	// user-B tries to delete user-A's personal sound.
	userB := models.NewID()
	_, err := env.client.DeleteSound(context.Background(), testutil.AuthedRequest(t, userB, &v1.DeleteSoundRequest{
		SoundId: soundID,
	}))
	if err == nil {
		t.Fatal("expected error when user-B deletes user-A's personal sound")
	}
	if connect.CodeOf(err) != connect.CodeNotFound {
		t.Errorf("code = %v, want NotFound", connect.CodeOf(err))
	}

	// Verify the sound still exists.
	env.soundStore.mu.Lock()
	_, exists := env.soundStore.sounds[soundID]
	env.soundStore.mu.Unlock()
	if !exists {
		t.Error("sound should still exist after unauthorized delete attempt")
	}
}

// TestListServerSounds_IDOR_NonMember verifies that a non-member cannot list
// sounds in a server they don't belong to.
func TestListServerSounds_IDOR_NonMember(t *testing.T) {
	env := setupIDORTestServer(t)

	ownerID := models.NewID()
	outsiderID := models.NewID()
	serverID, _ := createServerWithMember(t, env, ownerID)

	_, err := env.client.ListServerSounds(context.Background(), testutil.AuthedRequest(t, outsiderID, &v1.ListServerSoundsRequest{
		ServerId: serverID,
	}))
	if err == nil {
		t.Fatal("expected error for non-member listing server sounds")
	}
	if connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Errorf("code = %v, want PermissionDenied", connect.CodeOf(err))
	}
}

// ---------------------------------------------------------------------------
// Emoji IDOR test
// ---------------------------------------------------------------------------

// TestDeleteEmoji_IDOR_OtherUsersPersonalEmoji verifies that user-B cannot delete
// user-A's personal emoji. The handler checks emoji.UserID != userID and returns
// CodeNotFound to avoid leaking existence.
func TestDeleteEmoji_IDOR_OtherUsersPersonalEmoji(t *testing.T) {
	env := setupIDORTestServer(t)

	userA := models.NewID()

	// Create a personal emoji owned by user-A.
	emojiID := models.NewID()
	env.emojiStore.mu.Lock()
	env.emojiStore.emojis[emojiID] = &models.Emoji{
		ID:           emojiID,
		UserID:       userA,
		ServerID:     "", // personal emoji (no server)
		Name:         "myemoji",
		AttachmentID: models.NewID(),
		CreatorID:    userA,
		CreatedAt:    time.Now(),
	}
	env.emojiStore.mu.Unlock()

	// user-B tries to delete user-A's personal emoji.
	userB := models.NewID()
	_, err := env.client.DeleteEmoji(context.Background(), testutil.AuthedRequest(t, userB, &v1.DeleteEmojiRequest{
		EmojiId: emojiID,
	}))
	if err == nil {
		t.Fatal("expected error when user-B deletes user-A's personal emoji")
	}
	if connect.CodeOf(err) != connect.CodeNotFound {
		t.Errorf("code = %v, want NotFound", connect.CodeOf(err))
	}

	// Verify the emoji still exists.
	env.emojiStore.mu.Lock()
	_, exists := env.emojiStore.emojis[emojiID]
	env.emojiStore.mu.Unlock()
	if !exists {
		t.Error("emoji should still exist after unauthorized delete attempt")
	}
}
