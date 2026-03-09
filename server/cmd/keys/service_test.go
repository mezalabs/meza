package main

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"

	"connectrpc.com/connect"
	v1 "github.com/mezalabs/meza/gen/meza/v1"
	"github.com/mezalabs/meza/gen/meza/v1/mezav1connect"
	"github.com/mezalabs/meza/internal/auth"
	"github.com/mezalabs/meza/internal/store"
	"github.com/mezalabs/meza/internal/testutil"
)

// ---------------------------------------------------------------------------
// Mock stores
// ---------------------------------------------------------------------------

// mockKeyStore implements store.KeyEnvelopeStorer for testing.
type mockKeyStore struct {
	mu         sync.Mutex
	publicKeys map[string][]byte                         // userID -> publicKey
	envelopes  map[string]map[string][]store.KeyEnvelope // channelID -> version_key -> envelopes
	versions   map[string]uint32                         // channelID -> currentVersion
}

func newMockKeyStore() *mockKeyStore {
	return &mockKeyStore{
		publicKeys: make(map[string][]byte),
		envelopes:  make(map[string]map[string][]store.KeyEnvelope),
		versions:   make(map[string]uint32),
	}
}

func versionKey(version uint32) string {
	return fmt.Sprintf("v%d", version)
}

func (m *mockKeyStore) RegisterPublicKey(_ context.Context, userID string, publicKey []byte) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	if existing, ok := m.publicKeys[userID]; ok {
		if string(existing) == string(publicKey) {
			return nil // idempotent
		}
		return store.ErrPublicKeyAlreadyRegistered
	}
	m.publicKeys[userID] = make([]byte, len(publicKey))
	copy(m.publicKeys[userID], publicKey)
	return nil
}

func (m *mockKeyStore) GetPublicKeys(_ context.Context, userIDs []string) (map[string][]byte, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	result := make(map[string][]byte)
	for _, id := range userIDs {
		if key, ok := m.publicKeys[id]; ok {
			result[id] = key
		}
	}
	return result, nil
}

func (m *mockKeyStore) StoreKeyEnvelopes(_ context.Context, channelID string, version uint32, envelopes []store.KeyEnvelope) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.envelopes[channelID] == nil {
		m.envelopes[channelID] = make(map[string][]store.KeyEnvelope)
	}
	m.envelopes[channelID][versionKey(version)] = envelopes

	if _, ok := m.versions[channelID]; !ok {
		m.versions[channelID] = version
	}
	return nil
}

func (m *mockKeyStore) GetKeyEnvelopes(_ context.Context, channelID string, userID string) ([]store.VersionedEnvelope, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	var result []store.VersionedEnvelope
	if channelEnvelopes, ok := m.envelopes[channelID]; ok {
		for vk, envs := range channelEnvelopes {
			var ver uint32
			fmt.Sscanf(vk, "v%d", &ver)
			for _, env := range envs {
				if env.UserID == userID {
					result = append(result, store.VersionedEnvelope{
						KeyVersion: ver,
						Envelope:   env.Envelope,
					})
				}
			}
		}
	}
	return result, nil
}

func (m *mockKeyStore) RotateChannelKey(_ context.Context, channelID string, expectedVersion uint32, envelopes []store.KeyEnvelope) (uint32, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if expectedVersion == 0 {
		// Atomic initial creation: only succeeds if no version exists.
		if _, exists := m.versions[channelID]; exists {
			return 0, store.ErrVersionMismatch
		}
		m.versions[channelID] = 1
		if m.envelopes[channelID] == nil {
			m.envelopes[channelID] = make(map[string][]store.KeyEnvelope)
		}
		m.envelopes[channelID][versionKey(1)] = envelopes
		return 1, nil
	}

	current, ok := m.versions[channelID]
	if !ok || current != expectedVersion {
		return 0, store.ErrVersionMismatch
	}

	newVersion := current + 1
	m.versions[channelID] = newVersion

	if m.envelopes[channelID] == nil {
		m.envelopes[channelID] = make(map[string][]store.KeyEnvelope)
	}
	m.envelopes[channelID][versionKey(newVersion)] = envelopes

	// Clean up removed member envelopes (mirror real store behavior).
	recipientSet := make(map[string]struct{})
	for _, env := range envelopes {
		recipientSet[env.UserID] = struct{}{}
	}
	for vk, envs := range m.envelopes[channelID] {
		var filtered []store.KeyEnvelope
		for _, env := range envs {
			if _, ok := recipientSet[env.UserID]; ok {
				filtered = append(filtered, env)
			}
		}
		m.envelopes[channelID][vk] = filtered
	}

	return newVersion, nil
}

func (m *mockKeyStore) HasChannelKeyVersion(_ context.Context, channelID string) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	_, ok := m.versions[channelID]
	return ok, nil
}

// mockPermStore implements viewChannelChecker for testing.
type mockPermStore struct {
	mu            sync.Mutex
	viewChannel   map[string]map[string]bool // channelID -> userID -> hasView
	publicKeys    map[string][]byte          // userID -> signing public key (for ListMembersWithViewChannel)
	channelServer map[string]string          // channelID -> serverID
}

func newMockPermStore() *mockPermStore {
	return &mockPermStore{
		viewChannel:   make(map[string]map[string]bool),
		publicKeys:    make(map[string][]byte),
		channelServer: make(map[string]string),
	}
}

func (m *mockPermStore) setChannelServer(channelID, serverID string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.channelServer[channelID] = serverID
}

func (m *mockPermStore) GetChannelServerID(_ context.Context, channelID string) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	serverID, ok := m.channelServer[channelID]
	if !ok {
		return "", store.ErrNotFound
	}
	return serverID, nil
}

func (m *mockPermStore) grantViewChannel(channelID, userID string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.viewChannel[channelID] == nil {
		m.viewChannel[channelID] = make(map[string]bool)
	}
	m.viewChannel[channelID][userID] = true
}

func (m *mockPermStore) revokeViewChannel(channelID, userID string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.viewChannel[channelID] != nil {
		delete(m.viewChannel[channelID], userID)
	}
}

func (m *mockPermStore) setPublicKey(userID string, key []byte) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.publicKeys[userID] = key
}

func (m *mockPermStore) HasViewChannel(_ context.Context, userID, channelID string) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if users, ok := m.viewChannel[channelID]; ok {
		return users[userID], nil
	}
	return false, nil
}

func (m *mockPermStore) ListMembersWithViewChannel(_ context.Context, channelID, cursor string, limit int) ([]store.MemberPublicKey, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	users, ok := m.viewChannel[channelID]
	if !ok {
		return nil, nil
	}

	// Collect and sort user IDs with ViewChannel.
	var ids []string
	for uid := range users {
		if users[uid] && uid > cursor {
			ids = append(ids, uid)
		}
	}
	// Sort for deterministic pagination.
	for i := 0; i < len(ids); i++ {
		for j := i + 1; j < len(ids); j++ {
			if ids[i] > ids[j] {
				ids[i], ids[j] = ids[j], ids[i]
			}
		}
	}

	if limit <= 0 || limit > 1000 {
		limit = 1000
	}
	if len(ids) > limit {
		ids = ids[:limit]
	}

	result := make([]store.MemberPublicKey, len(ids))
	for i, uid := range ids {
		result[i] = store.MemberPublicKey{
			UserID:           uid,
			SigningPublicKey: m.publicKeys[uid],
		}
	}
	return result, nil
}

// mockChatStore implements envelopeRecipientChecker for testing.
type mockChatStore struct {
	mu            sync.Mutex
	members       map[string]map[string]bool // channelID -> userID -> true (channel-level membership)
	channelServer map[string]string          // channelID -> serverID
	serverMembers map[string]map[string]bool // serverID -> userID -> true
}

func newMockChatStore() *mockChatStore {
	return &mockChatStore{
		members:       make(map[string]map[string]bool),
		channelServer: make(map[string]string),
		serverMembers: make(map[string]map[string]bool),
	}
}

func (m *mockChatStore) setChannelServer(channelID, serverID string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.channelServer[channelID] = serverID
}

func (m *mockChatStore) addServerMember(serverID, userID string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.serverMembers[serverID] == nil {
		m.serverMembers[serverID] = make(map[string]bool)
	}
	m.serverMembers[serverID][userID] = true
}

func (m *mockChatStore) addChannelMember(channelID, userID string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.members[channelID] == nil {
		m.members[channelID] = make(map[string]bool)
	}
	m.members[channelID][userID] = true
}

func (m *mockChatStore) removeChannelMember(channelID, userID string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.members[channelID], userID)
}

func (m *mockChatStore) IsChannelMember(_ context.Context, channelID, userID string) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if members, ok := m.members[channelID]; ok {
		return members[userID], nil
	}
	return false, nil
}

func (m *mockChatStore) AreServerMembersOfChannel(_ context.Context, channelID string, userIDs []string) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	serverID, ok := m.channelServer[channelID]
	if !ok {
		// No server mapping means no members can match.
		return len(userIDs) == 0, nil
	}
	members := m.serverMembers[serverID]
	for _, uid := range userIDs {
		if !members[uid] {
			return false, nil
		}
	}
	return true, nil
}

// ---------------------------------------------------------------------------
// Test environment
// ---------------------------------------------------------------------------

type testEnv struct {
	client    mezav1connect.KeyServiceClient
	keyStore  *mockKeyStore
	permStore *mockPermStore
	chatStore *mockChatStore
}

func setupTestEnv(t *testing.T) *testEnv {
	t.Helper()

	ks := newMockKeyStore()
	ps := newMockPermStore()
	cs := newMockChatStore()
	svc := newKeyService(ks, ps, cs, nil)

	mux := http.NewServeMux()
	path, handler := mezav1connect.NewKeyServiceHandler(svc,
		connect.WithInterceptors(auth.NewConnectInterceptor(testutil.TestEd25519Keys.PublicKey)),
	)
	mux.Handle(path, handler)

	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	client := mezav1connect.NewKeyServiceClient(http.DefaultClient, srv.URL)

	return &testEnv{client: client, keyStore: ks, permStore: ps, chatStore: cs}
}

func makeEnvelope(userID string) *v1.KeyEnvelope {
	return &v1.KeyEnvelope{
		UserId:   userID,
		Envelope: make([]byte, 92),
	}
}

// ---------------------------------------------------------------------------
// RegisterPublicKey tests
// ---------------------------------------------------------------------------

func TestRegisterPublicKey_ValidKey(t *testing.T) {
	env := setupTestEnv(t)
	key := make([]byte, 32)
	key[0] = 0x42

	_, err := env.client.RegisterPublicKey(
		context.Background(),
		testutil.AuthedRequest(t, "user-1", &v1.RegisterPublicKeyRequest{SigningPublicKey: key}),
	)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// Verify key was stored.
	stored := env.keyStore.publicKeys["user-1"]
	if len(stored) != 32 || stored[0] != 0x42 {
		t.Fatalf("stored key mismatch: %v", stored)
	}
}

func TestRegisterPublicKey_Idempotent(t *testing.T) {
	env := setupTestEnv(t)
	key := make([]byte, 32)

	for i := 0; i < 2; i++ {
		_, err := env.client.RegisterPublicKey(
			context.Background(),
			testutil.AuthedRequest(t, "user-1", &v1.RegisterPublicKeyRequest{SigningPublicKey: key}),
		)
		if err != nil {
			t.Fatalf("attempt %d: unexpected error: %v", i+1, err)
		}
	}
}

func TestRegisterPublicKey_DifferentKeyConflict(t *testing.T) {
	env := setupTestEnv(t)

	key1 := make([]byte, 32)
	key1[0] = 0x01
	key2 := make([]byte, 32)
	key2[0] = 0x02

	_, err := env.client.RegisterPublicKey(
		context.Background(),
		testutil.AuthedRequest(t, "user-1", &v1.RegisterPublicKeyRequest{SigningPublicKey: key1}),
	)
	if err != nil {
		t.Fatalf("first registration: %v", err)
	}

	_, err = env.client.RegisterPublicKey(
		context.Background(),
		testutil.AuthedRequest(t, "user-1", &v1.RegisterPublicKeyRequest{SigningPublicKey: key2}),
	)
	if err == nil {
		t.Fatal("expected error for different key, got nil")
	}
	if connect.CodeOf(err) != connect.CodeAlreadyExists {
		t.Fatalf("expected CodeAlreadyExists, got %v", connect.CodeOf(err))
	}
}

func TestRegisterPublicKey_InvalidSize(t *testing.T) {
	env := setupTestEnv(t)

	tests := []struct {
		name string
		size int
	}{
		{"31 bytes", 31},
		{"33 bytes", 33},
		{"0 bytes", 0},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			_, err := env.client.RegisterPublicKey(
				context.Background(),
				testutil.AuthedRequest(t, "user-1", &v1.RegisterPublicKeyRequest{SigningPublicKey: make([]byte, tc.size)}),
			)
			if err == nil {
				t.Fatal("expected error, got nil")
			}
			if connect.CodeOf(err) != connect.CodeInvalidArgument {
				t.Fatalf("expected CodeInvalidArgument, got %v", connect.CodeOf(err))
			}
		})
	}
}

func TestRegisterPublicKey_Unauthenticated(t *testing.T) {
	env := setupTestEnv(t)

	_, err := env.client.RegisterPublicKey(
		context.Background(),
		connect.NewRequest(&v1.RegisterPublicKeyRequest{SigningPublicKey: make([]byte, 32)}),
	)
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if connect.CodeOf(err) != connect.CodeUnauthenticated {
		t.Fatalf("expected CodeUnauthenticated, got %v", connect.CodeOf(err))
	}
}

// ---------------------------------------------------------------------------
// GetPublicKeys tests
// ---------------------------------------------------------------------------

func TestGetPublicKeys_ReturnsRegisteredKeys(t *testing.T) {
	env := setupTestEnv(t)

	// Seed keys directly in mock.
	env.keyStore.publicKeys["user-1"] = make([]byte, 32)
	env.keyStore.publicKeys["user-1"][0] = 0xAA
	env.keyStore.publicKeys["user-2"] = make([]byte, 32)
	env.keyStore.publicKeys["user-2"][0] = 0xBB

	resp, err := env.client.GetPublicKeys(
		context.Background(),
		testutil.AuthedRequest(t, "caller", &v1.GetPublicKeysRequest{UserIds: []string{"user-1", "user-2", "user-3"}}),
	)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	keys := resp.Msg.PublicKeys
	if len(keys) != 2 {
		t.Fatalf("expected 2 keys, got %d", len(keys))
	}
	if keys["user-1"][0] != 0xAA || keys["user-2"][0] != 0xBB {
		t.Fatal("key contents mismatch")
	}
	if _, ok := keys["user-3"]; ok {
		t.Fatal("user-3 should not have a key")
	}
}

func TestGetPublicKeys_EmptyUserIDs(t *testing.T) {
	env := setupTestEnv(t)

	_, err := env.client.GetPublicKeys(
		context.Background(),
		testutil.AuthedRequest(t, "caller", &v1.GetPublicKeysRequest{UserIds: nil}),
	)
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("expected CodeInvalidArgument, got %v", connect.CodeOf(err))
	}
}

func TestGetPublicKeys_TooManyUserIDs(t *testing.T) {
	env := setupTestEnv(t)

	ids := make([]string, 101)
	for i := range ids {
		ids[i] = fmt.Sprintf("user-%d", i)
	}

	_, err := env.client.GetPublicKeys(
		context.Background(),
		testutil.AuthedRequest(t, "caller", &v1.GetPublicKeysRequest{UserIds: ids}),
	)
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("expected CodeInvalidArgument, got %v", connect.CodeOf(err))
	}
}

func TestGetPublicKeys_Unauthenticated(t *testing.T) {
	env := setupTestEnv(t)

	_, err := env.client.GetPublicKeys(
		context.Background(),
		connect.NewRequest(&v1.GetPublicKeysRequest{UserIds: []string{"user-1"}}),
	)
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if connect.CodeOf(err) != connect.CodeUnauthenticated {
		t.Fatalf("expected CodeUnauthenticated, got %v", connect.CodeOf(err))
	}
}

// ---------------------------------------------------------------------------
// StoreKeyEnvelopes tests
// ---------------------------------------------------------------------------

func TestStoreKeyEnvelopes_ValidEnvelopes(t *testing.T) {
	env := setupTestEnv(t)
	env.permStore.grantViewChannel("ch-1", "user-1")
	env.chatStore.setChannelServer("ch-1", "srv-1")
	env.chatStore.addServerMember("srv-1", "user-1")
	env.chatStore.addServerMember("srv-1", "user-2")

	_, err := env.client.StoreKeyEnvelopes(
		context.Background(),
		testutil.AuthedRequest(t, "user-1", &v1.StoreKeyEnvelopesRequest{
			ChannelId:  "ch-1",
			KeyVersion: 1,
			Envelopes:  []*v1.KeyEnvelope{makeEnvelope("user-1"), makeEnvelope("user-2")},
		}),
	)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// Verify envelopes were stored.
	stored := env.keyStore.envelopes["ch-1"][versionKey(1)]
	if len(stored) != 2 {
		t.Fatalf("expected 2 envelopes, got %d", len(stored))
	}
}

func TestStoreKeyEnvelopes_NoViewChannel(t *testing.T) {
	env := setupTestEnv(t)
	// user-1 does NOT have ViewChannel on ch-1.

	_, err := env.client.StoreKeyEnvelopes(
		context.Background(),
		testutil.AuthedRequest(t, "user-1", &v1.StoreKeyEnvelopesRequest{
			ChannelId:  "ch-1",
			KeyVersion: 1,
			Envelopes:  []*v1.KeyEnvelope{makeEnvelope("user-1")},
		}),
	)
	if err == nil {
		t.Fatal("expected error for no ViewChannel, got nil")
	}
	if connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Fatalf("expected CodePermissionDenied, got %v", connect.CodeOf(err))
	}
}

func TestStoreKeyEnvelopes_WrongEnvelopeSize(t *testing.T) {
	env := setupTestEnv(t)
	env.permStore.grantViewChannel("ch-1", "user-1")

	tests := []struct {
		name string
		size int
	}{
		{"91 bytes", 91},
		{"93 bytes", 93},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			_, err := env.client.StoreKeyEnvelopes(
				context.Background(),
				testutil.AuthedRequest(t, "user-1", &v1.StoreKeyEnvelopesRequest{
					ChannelId:  "ch-1",
					KeyVersion: 1,
					Envelopes:  []*v1.KeyEnvelope{{UserId: "user-1", Envelope: make([]byte, tc.size)}},
				}),
			)
			if err == nil {
				t.Fatal("expected error, got nil")
			}
			if connect.CodeOf(err) != connect.CodeInvalidArgument {
				t.Fatalf("expected CodeInvalidArgument, got %v", connect.CodeOf(err))
			}
		})
	}
}

func TestStoreKeyEnvelopes_EmptyEnvelopes(t *testing.T) {
	env := setupTestEnv(t)
	env.permStore.grantViewChannel("ch-1", "user-1")

	_, err := env.client.StoreKeyEnvelopes(
		context.Background(),
		testutil.AuthedRequest(t, "user-1", &v1.StoreKeyEnvelopesRequest{
			ChannelId:  "ch-1",
			KeyVersion: 1,
			Envelopes:  nil,
		}),
	)
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("expected CodeInvalidArgument, got %v", connect.CodeOf(err))
	}
}

func TestStoreKeyEnvelopes_VersionZero(t *testing.T) {
	env := setupTestEnv(t)
	env.permStore.grantViewChannel("ch-1", "user-1")

	_, err := env.client.StoreKeyEnvelopes(
		context.Background(),
		testutil.AuthedRequest(t, "user-1", &v1.StoreKeyEnvelopesRequest{
			ChannelId:  "ch-1",
			KeyVersion: 0,
			Envelopes:  []*v1.KeyEnvelope{makeEnvelope("user-1")},
		}),
	)
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("expected CodeInvalidArgument, got %v", connect.CodeOf(err))
	}
}

func TestStoreKeyEnvelopes_TooManyEnvelopes(t *testing.T) {
	env := setupTestEnv(t)
	env.permStore.grantViewChannel("ch-1", "user-1")

	envs := make([]*v1.KeyEnvelope, 1001)
	for i := range envs {
		envs[i] = &v1.KeyEnvelope{
			UserId:   fmt.Sprintf("user-%d", i),
			Envelope: make([]byte, 92),
		}
	}

	_, err := env.client.StoreKeyEnvelopes(
		context.Background(),
		testutil.AuthedRequest(t, "user-1", &v1.StoreKeyEnvelopesRequest{
			ChannelId:  "ch-1",
			KeyVersion: 1,
			Envelopes:  envs,
		}),
	)
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("expected CodeInvalidArgument, got %v", connect.CodeOf(err))
	}
}

func TestStoreKeyEnvelopes_Unauthenticated(t *testing.T) {
	env := setupTestEnv(t)

	_, err := env.client.StoreKeyEnvelopes(
		context.Background(),
		connect.NewRequest(&v1.StoreKeyEnvelopesRequest{
			ChannelId:  "ch-1",
			KeyVersion: 1,
			Envelopes:  []*v1.KeyEnvelope{makeEnvelope("user-1")},
		}),
	)
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if connect.CodeOf(err) != connect.CodeUnauthenticated {
		t.Fatalf("expected CodeUnauthenticated, got %v", connect.CodeOf(err))
	}
}

func TestStoreKeyEnvelopes_NonMemberRecipient(t *testing.T) {
	env := setupTestEnv(t)
	env.permStore.grantViewChannel("ch-1", "user-1")
	env.chatStore.setChannelServer("ch-1", "srv-1")
	env.chatStore.addServerMember("srv-1", "user-1")
	// user-2 is NOT a server member.

	_, err := env.client.StoreKeyEnvelopes(
		context.Background(),
		testutil.AuthedRequest(t, "user-1", &v1.StoreKeyEnvelopesRequest{
			ChannelId:  "ch-1",
			KeyVersion: 1,
			Envelopes:  []*v1.KeyEnvelope{makeEnvelope("user-1"), makeEnvelope("user-2")},
		}),
	)
	if err == nil {
		t.Fatal("expected error for non-member recipient, got nil")
	}
	if connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("expected CodeInvalidArgument, got %v", connect.CodeOf(err))
	}
}

func TestRotateChannelKey_NonMemberRecipient(t *testing.T) {
	env := setupTestEnv(t)
	env.permStore.grantViewChannel("ch-1", "user-1")
	env.chatStore.setChannelServer("ch-1", "srv-1")
	env.chatStore.addServerMember("srv-1", "user-1")
	// user-2 is NOT a server member.

	env.keyStore.versions["ch-1"] = 1

	_, err := env.client.RotateChannelKey(
		context.Background(),
		testutil.AuthedRequest(t, "user-1", &v1.RotateChannelKeyRequest{
			ChannelId:       "ch-1",
			ExpectedVersion: 1,
			Envelopes:       []*v1.KeyEnvelope{makeEnvelope("user-1"), makeEnvelope("user-2")},
		}),
	)
	if err == nil {
		t.Fatal("expected error for non-member recipient, got nil")
	}
	if connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("expected CodeInvalidArgument, got %v", connect.CodeOf(err))
	}
}

// ---------------------------------------------------------------------------
// GetKeyEnvelopes tests
// ---------------------------------------------------------------------------

func TestGetKeyEnvelopes_WithViewChannel(t *testing.T) {
	env := setupTestEnv(t)
	env.permStore.grantViewChannel("ch-1", "user-1")

	// Seed envelopes directly.
	env.keyStore.envelopes["ch-1"] = map[string][]store.KeyEnvelope{
		versionKey(1): {
			{UserID: "user-1", Envelope: make([]byte, 92)},
			{UserID: "user-2", Envelope: make([]byte, 92)},
		},
	}
	env.keyStore.versions["ch-1"] = 1

	resp, err := env.client.GetKeyEnvelopes(
		context.Background(),
		testutil.AuthedRequest(t, "user-1", &v1.GetKeyEnvelopesRequest{ChannelId: "ch-1"}),
	)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// Should only return user-1's envelope.
	if len(resp.Msg.Envelopes) != 1 {
		t.Fatalf("expected 1 envelope, got %d", len(resp.Msg.Envelopes))
	}
	if resp.Msg.Envelopes[0].KeyVersion != 1 {
		t.Fatalf("expected version 1, got %d", resp.Msg.Envelopes[0].KeyVersion)
	}
}

func TestGetKeyEnvelopes_FallbackWithChannelMembership(t *testing.T) {
	env := setupTestEnv(t)
	// user-1 does NOT have ViewChannel but IS a channel_member (ViewChannel revoked).
	env.chatStore.addChannelMember("ch-1", "user-1")

	env.keyStore.envelopes["ch-1"] = map[string][]store.KeyEnvelope{
		versionKey(1): {{UserID: "user-1", Envelope: make([]byte, 92)}},
	}
	env.keyStore.versions["ch-1"] = 1

	resp, err := env.client.GetKeyEnvelopes(
		context.Background(),
		testutil.AuthedRequest(t, "user-1", &v1.GetKeyEnvelopesRequest{ChannelId: "ch-1"}),
	)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(resp.Msg.Envelopes) != 1 {
		t.Fatalf("expected 1 envelope, got %d", len(resp.Msg.Envelopes))
	}
}

func TestGetKeyEnvelopes_NoAccessAtAll(t *testing.T) {
	env := setupTestEnv(t)
	// user-1 has neither ViewChannel nor channel_member.

	_, err := env.client.GetKeyEnvelopes(
		context.Background(),
		testutil.AuthedRequest(t, "user-1", &v1.GetKeyEnvelopesRequest{ChannelId: "ch-1"}),
	)
	if err == nil {
		t.Fatal("expected error for no access, got nil")
	}
	if connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Fatalf("expected CodePermissionDenied, got %v", connect.CodeOf(err))
	}
}

func TestGetKeyEnvelopes_EmptyChannelID(t *testing.T) {
	env := setupTestEnv(t)

	_, err := env.client.GetKeyEnvelopes(
		context.Background(),
		testutil.AuthedRequest(t, "user-1", &v1.GetKeyEnvelopesRequest{ChannelId: ""}),
	)
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("expected CodeInvalidArgument, got %v", connect.CodeOf(err))
	}
}

func TestGetKeyEnvelopes_Unauthenticated(t *testing.T) {
	env := setupTestEnv(t)

	_, err := env.client.GetKeyEnvelopes(
		context.Background(),
		connect.NewRequest(&v1.GetKeyEnvelopesRequest{ChannelId: "ch-1"}),
	)
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if connect.CodeOf(err) != connect.CodeUnauthenticated {
		t.Fatalf("expected CodeUnauthenticated, got %v", connect.CodeOf(err))
	}
}

// ---------------------------------------------------------------------------
// RotateChannelKey tests
// ---------------------------------------------------------------------------

func TestRotateChannelKey_ValidRotation(t *testing.T) {
	env := setupTestEnv(t)
	env.permStore.grantViewChannel("ch-1", "user-1")
	env.permStore.grantViewChannel("ch-1", "user-2")
	env.chatStore.setChannelServer("ch-1", "srv-1")
	env.chatStore.addServerMember("srv-1", "user-1")
	env.chatStore.addServerMember("srv-1", "user-2")

	// Seed initial version.
	env.keyStore.versions["ch-1"] = 1
	env.keyStore.envelopes["ch-1"] = map[string][]store.KeyEnvelope{
		versionKey(1): {
			{UserID: "user-1", Envelope: make([]byte, 92)},
			{UserID: "user-2", Envelope: make([]byte, 92)},
		},
	}

	resp, err := env.client.RotateChannelKey(
		context.Background(),
		testutil.AuthedRequest(t, "user-1", &v1.RotateChannelKeyRequest{
			ChannelId:       "ch-1",
			ExpectedVersion: 1,
			Envelopes:       []*v1.KeyEnvelope{makeEnvelope("user-1"), makeEnvelope("user-2")},
		}),
	)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.Msg.NewVersion != 2 {
		t.Fatalf("expected new version 2, got %d", resp.Msg.NewVersion)
	}
}

func TestRotateChannelKey_VersionMismatch(t *testing.T) {
	env := setupTestEnv(t)
	env.permStore.grantViewChannel("ch-1", "user-1")
	env.chatStore.setChannelServer("ch-1", "srv-1")
	env.chatStore.addServerMember("srv-1", "user-1")

	// Seed version 2 (caller expects 1).
	env.keyStore.versions["ch-1"] = 2

	_, err := env.client.RotateChannelKey(
		context.Background(),
		testutil.AuthedRequest(t, "user-1", &v1.RotateChannelKeyRequest{
			ChannelId:       "ch-1",
			ExpectedVersion: 1,
			Envelopes:       []*v1.KeyEnvelope{makeEnvelope("user-1")},
		}),
	)
	if err == nil {
		t.Fatal("expected error for version mismatch, got nil")
	}
	if connect.CodeOf(err) != connect.CodeAborted {
		t.Fatalf("expected CodeAborted, got %v", connect.CodeOf(err))
	}
}

func TestRotateChannelKey_NoViewChannel(t *testing.T) {
	env := setupTestEnv(t)
	// user-1 does NOT have ViewChannel.

	env.keyStore.versions["ch-1"] = 1

	_, err := env.client.RotateChannelKey(
		context.Background(),
		testutil.AuthedRequest(t, "user-1", &v1.RotateChannelKeyRequest{
			ChannelId:       "ch-1",
			ExpectedVersion: 1,
			Envelopes:       []*v1.KeyEnvelope{makeEnvelope("user-1")},
		}),
	)
	if err == nil {
		t.Fatal("expected error for no ViewChannel, got nil")
	}
	if connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Fatalf("expected CodePermissionDenied, got %v", connect.CodeOf(err))
	}
}

func TestRotateChannelKey_EmptyEnvelopes(t *testing.T) {
	env := setupTestEnv(t)
	env.permStore.grantViewChannel("ch-1", "user-1")

	env.keyStore.versions["ch-1"] = 1

	_, err := env.client.RotateChannelKey(
		context.Background(),
		testutil.AuthedRequest(t, "user-1", &v1.RotateChannelKeyRequest{
			ChannelId:       "ch-1",
			ExpectedVersion: 1,
			Envelopes:       nil,
		}),
	)
	if err == nil {
		t.Fatal("expected error for empty envelopes, got nil")
	}
	if connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("expected CodeInvalidArgument, got %v", connect.CodeOf(err))
	}
}

func TestRotateChannelKey_ExpectedVersionZero_LazyInit(t *testing.T) {
	env := setupTestEnv(t)
	env.permStore.grantViewChannel("ch-1", "user-1")
	env.chatStore.setChannelServer("ch-1", "srv-1")
	env.chatStore.addServerMember("srv-1", "user-1")

	// No version exists yet — this is the lazy init case.
	resp, err := env.client.RotateChannelKey(
		context.Background(),
		testutil.AuthedRequest(t, "user-1", &v1.RotateChannelKeyRequest{
			ChannelId:       "ch-1",
			ExpectedVersion: 0,
			Envelopes:       []*v1.KeyEnvelope{makeEnvelope("user-1")},
		}),
	)
	if err != nil {
		t.Fatalf("unexpected error for lazy init: %v", err)
	}
	if resp.Msg.NewVersion != 1 {
		t.Fatalf("expected new version 1, got %d", resp.Msg.NewVersion)
	}

	// Second attempt should fail (version already exists).
	_, err = env.client.RotateChannelKey(
		context.Background(),
		testutil.AuthedRequest(t, "user-1", &v1.RotateChannelKeyRequest{
			ChannelId:       "ch-1",
			ExpectedVersion: 0,
			Envelopes:       []*v1.KeyEnvelope{makeEnvelope("user-1")},
		}),
	)
	if err == nil {
		t.Fatal("expected error for duplicate lazy init, got nil")
	}
	if connect.CodeOf(err) != connect.CodeAborted {
		t.Fatalf("expected CodeAborted, got %v", connect.CodeOf(err))
	}
}

func TestRotateChannelKey_Unauthenticated(t *testing.T) {
	env := setupTestEnv(t)

	_, err := env.client.RotateChannelKey(
		context.Background(),
		connect.NewRequest(&v1.RotateChannelKeyRequest{
			ChannelId:       "ch-1",
			ExpectedVersion: 1,
			Envelopes:       []*v1.KeyEnvelope{makeEnvelope("user-1")},
		}),
	)
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if connect.CodeOf(err) != connect.CodeUnauthenticated {
		t.Fatalf("expected CodeUnauthenticated, got %v", connect.CodeOf(err))
	}
}

func TestRotateChannelKey_ConcurrentRotation(t *testing.T) {
	env := setupTestEnv(t)

	// Grant ViewChannel and server membership to 10 users.
	env.chatStore.setChannelServer("ch-1", "srv-1")
	for i := 0; i < 10; i++ {
		uid := fmt.Sprintf("user-%d", i)
		env.permStore.grantViewChannel("ch-1", uid)
		env.chatStore.addServerMember("srv-1", uid)
	}

	// Seed initial version.
	env.keyStore.versions["ch-1"] = 1
	env.keyStore.envelopes["ch-1"] = map[string][]store.KeyEnvelope{
		versionKey(1): {{UserID: "user-0", Envelope: make([]byte, 92)}},
	}

	const goroutines = 10
	var wg sync.WaitGroup
	var successes, aborts atomic.Int32

	wg.Add(goroutines)
	for i := 0; i < goroutines; i++ {
		go func(idx int) {
			defer wg.Done()
			userID := fmt.Sprintf("user-%d", idx)

			envs := make([]*v1.KeyEnvelope, 10)
			for j := 0; j < 10; j++ {
				envs[j] = makeEnvelope(fmt.Sprintf("user-%d", j))
			}

			_, err := env.client.RotateChannelKey(
				context.Background(),
				testutil.AuthedRequest(t, userID, &v1.RotateChannelKeyRequest{
					ChannelId:       "ch-1",
					ExpectedVersion: 1,
					Envelopes:       envs,
				}),
			)
			if err == nil {
				successes.Add(1)
			} else if connect.CodeOf(err) == connect.CodeAborted {
				aborts.Add(1)
			} else {
				t.Errorf("unexpected error code: %v (err: %v)", connect.CodeOf(err), err)
			}
		}(i)
	}

	wg.Wait()

	if successes.Load() != 1 {
		t.Fatalf("expected exactly 1 success, got %d", successes.Load())
	}
	if aborts.Load() != goroutines-1 {
		t.Fatalf("expected %d aborts, got %d", goroutines-1, aborts.Load())
	}
}

// ---------------------------------------------------------------------------
// ListMembersWithViewChannel tests
// ---------------------------------------------------------------------------

func TestListMembersWithViewChannel_ReturnsMembers(t *testing.T) {
	env := setupTestEnv(t)
	env.permStore.grantViewChannel("ch-1", "caller")
	env.permStore.grantViewChannel("ch-1", "alice")
	env.permStore.grantViewChannel("ch-1", "bob")
	env.permStore.setPublicKey("alice", make([]byte, 32))
	// bob has no public key — should still be returned with nil key.

	resp, err := env.client.ListMembersWithViewChannel(
		context.Background(),
		testutil.AuthedRequest(t, "caller", &v1.ListMembersWithViewChannelRequest{ChannelId: "ch-1"}),
	)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(resp.Msg.Members) != 3 {
		t.Fatalf("expected 3 members, got %d", len(resp.Msg.Members))
	}
}

func TestListMembersWithViewChannel_NoViewChannel(t *testing.T) {
	env := setupTestEnv(t)
	// caller does NOT have ViewChannel.

	_, err := env.client.ListMembersWithViewChannel(
		context.Background(),
		testutil.AuthedRequest(t, "caller", &v1.ListMembersWithViewChannelRequest{ChannelId: "ch-1"}),
	)
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Fatalf("expected CodePermissionDenied, got %v", connect.CodeOf(err))
	}
}

func TestListMembersWithViewChannel_Unauthenticated(t *testing.T) {
	env := setupTestEnv(t)

	_, err := env.client.ListMembersWithViewChannel(
		context.Background(),
		connect.NewRequest(&v1.ListMembersWithViewChannelRequest{ChannelId: "ch-1"}),
	)
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if connect.CodeOf(err) != connect.CodeUnauthenticated {
		t.Fatalf("expected CodeUnauthenticated, got %v", connect.CodeOf(err))
	}
}

func TestListMembersWithViewChannel_EmptyChannelID(t *testing.T) {
	env := setupTestEnv(t)

	_, err := env.client.ListMembersWithViewChannel(
		context.Background(),
		testutil.AuthedRequest(t, "caller", &v1.ListMembersWithViewChannelRequest{ChannelId: ""}),
	)
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("expected CodeInvalidArgument, got %v", connect.CodeOf(err))
	}
}

// ---------------------------------------------------------------------------
// Cross-RPC integration: Store + Get + Rotate
// ---------------------------------------------------------------------------

func TestIntegration_StoreGetRotateFlow(t *testing.T) {
	env := setupTestEnv(t)
	env.permStore.grantViewChannel("ch-1", "alice")
	env.permStore.grantViewChannel("ch-1", "bob")
	env.chatStore.setChannelServer("ch-1", "srv-1")
	env.chatStore.addServerMember("srv-1", "alice")
	env.chatStore.addServerMember("srv-1", "bob")
	env.chatStore.addChannelMember("ch-1", "alice")
	env.chatStore.addChannelMember("ch-1", "bob")

	// 1. Store initial envelopes.
	_, err := env.client.StoreKeyEnvelopes(
		context.Background(),
		testutil.AuthedRequest(t, "alice", &v1.StoreKeyEnvelopesRequest{
			ChannelId:  "ch-1",
			KeyVersion: 1,
			Envelopes:  []*v1.KeyEnvelope{makeEnvelope("alice"), makeEnvelope("bob")},
		}),
	)
	if err != nil {
		t.Fatalf("store: %v", err)
	}

	// 2. Get envelopes as bob.
	getResp, err := env.client.GetKeyEnvelopes(
		context.Background(),
		testutil.AuthedRequest(t, "bob", &v1.GetKeyEnvelopesRequest{ChannelId: "ch-1"}),
	)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if len(getResp.Msg.Envelopes) != 1 {
		t.Fatalf("expected 1 envelope for bob, got %d", len(getResp.Msg.Envelopes))
	}

	// 3. Revoke bob's ViewChannel but keep channel_member row (simulates access revocation).
	env.permStore.revokeViewChannel("ch-1", "bob")

	// Bob can still get envelopes via channel_member fallback.
	getResp, err = env.client.GetKeyEnvelopes(
		context.Background(),
		testutil.AuthedRequest(t, "bob", &v1.GetKeyEnvelopesRequest{ChannelId: "ch-1"}),
	)
	if err != nil {
		t.Fatalf("get after revoke: %v", err)
	}
	if len(getResp.Msg.Envelopes) != 1 {
		t.Fatalf("expected 1 envelope for bob via fallback, got %d", len(getResp.Msg.Envelopes))
	}

	// 4. Remove bob from channel_members too — now no access.
	env.chatStore.removeChannelMember("ch-1", "bob")

	_, err = env.client.GetKeyEnvelopes(
		context.Background(),
		testutil.AuthedRequest(t, "bob", &v1.GetKeyEnvelopesRequest{ChannelId: "ch-1"}),
	)
	if err == nil {
		t.Fatal("expected error for fully removed member, got nil")
	}
	if connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Fatalf("expected CodePermissionDenied, got %v", connect.CodeOf(err))
	}
}

// ---------------------------------------------------------------------------
// RequestChannelKeys tests
// ---------------------------------------------------------------------------

func TestRequestChannelKeys_Unauthenticated(t *testing.T) {
	env := setupTestEnv(t)

	_, err := env.client.RequestChannelKeys(
		context.Background(),
		connect.NewRequest(&v1.RequestChannelKeysRequest{ChannelId: "ch-1"}),
	)
	if err == nil {
		t.Fatal("expected error for unauthenticated request, got nil")
	}
	if connect.CodeOf(err) != connect.CodeUnauthenticated {
		t.Fatalf("expected CodeUnauthenticated, got %v", connect.CodeOf(err))
	}
}

func TestRequestChannelKeys_EmptyChannelID(t *testing.T) {
	env := setupTestEnv(t)

	_, err := env.client.RequestChannelKeys(
		context.Background(),
		testutil.AuthedRequest(t, "user-1", &v1.RequestChannelKeysRequest{ChannelId: ""}),
	)
	if err == nil {
		t.Fatal("expected error for empty channel_id, got nil")
	}
	if connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("expected CodeInvalidArgument, got %v", connect.CodeOf(err))
	}
}

func TestRequestChannelKeys_NoViewChannel(t *testing.T) {
	env := setupTestEnv(t)

	_, err := env.client.RequestChannelKeys(
		context.Background(),
		testutil.AuthedRequest(t, "user-1", &v1.RequestChannelKeysRequest{ChannelId: "ch-1"}),
	)
	if err == nil {
		t.Fatal("expected error for missing ViewChannel, got nil")
	}
	if connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Fatalf("expected CodePermissionDenied, got %v", connect.CodeOf(err))
	}
}

func TestRequestChannelKeys_DMChannel(t *testing.T) {
	env := setupTestEnv(t)
	env.permStore.grantViewChannel("dm-ch-1", "user-1")
	// No channel-server mapping — simulates DM channel.

	_, err := env.client.RequestChannelKeys(
		context.Background(),
		testutil.AuthedRequest(t, "user-1", &v1.RequestChannelKeysRequest{ChannelId: "dm-ch-1"}),
	)
	if err == nil {
		t.Fatal("expected error for DM channel, got nil")
	}
	if connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("expected CodeInvalidArgument for DM channel, got %v", connect.CodeOf(err))
	}
}

func TestRequestChannelKeys_ValidRequest(t *testing.T) {
	env := setupTestEnv(t)
	env.permStore.grantViewChannel("ch-1", "user-1")
	env.permStore.setChannelServer("ch-1", "srv-1")

	_, err := env.client.RequestChannelKeys(
		context.Background(),
		testutil.AuthedRequest(t, "user-1", &v1.RequestChannelKeysRequest{ChannelId: "ch-1"}),
	)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestRequestChannelKeys_Throttled(t *testing.T) {
	env := setupTestEnv(t)
	env.permStore.grantViewChannel("ch-1", "user-1")
	env.permStore.setChannelServer("ch-1", "srv-1")

	// First request should succeed.
	_, err := env.client.RequestChannelKeys(
		context.Background(),
		testutil.AuthedRequest(t, "user-1", &v1.RequestChannelKeysRequest{ChannelId: "ch-1"}),
	)
	if err != nil {
		t.Fatalf("first request failed: %v", err)
	}

	// Second request within cooldown should also "succeed" (silently throttled).
	_, err = env.client.RequestChannelKeys(
		context.Background(),
		testutil.AuthedRequest(t, "user-1", &v1.RequestChannelKeysRequest{ChannelId: "ch-1"}),
	)
	if err != nil {
		t.Fatalf("throttled request should succeed silently, got: %v", err)
	}

	// Different channel should not be throttled.
	env.permStore.grantViewChannel("ch-2", "user-1")
	env.permStore.setChannelServer("ch-2", "srv-1")
	_, err = env.client.RequestChannelKeys(
		context.Background(),
		testutil.AuthedRequest(t, "user-1", &v1.RequestChannelKeysRequest{ChannelId: "ch-2"}),
	)
	if err != nil {
		t.Fatalf("different channel should not be throttled: %v", err)
	}
}
