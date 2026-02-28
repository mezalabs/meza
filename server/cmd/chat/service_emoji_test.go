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
	v1 "github.com/meza-chat/meza/gen/meza/v1"
	"github.com/meza-chat/meza/gen/meza/v1/mezav1connect"
	"github.com/meza-chat/meza/internal/auth"
	"github.com/meza-chat/meza/internal/models"
	"github.com/meza-chat/meza/internal/permissions"
	"github.com/meza-chat/meza/internal/testutil"
)

// statefulMockEmojiStore tracks emoji state for testing (unlike the bare mockEmojiStore).
type statefulMockEmojiStore struct {
	mu     sync.Mutex
	emojis map[string]*models.Emoji // emojiID -> emoji
}

func newStatefulMockEmojiStore() *statefulMockEmojiStore {
	return &statefulMockEmojiStore{emojis: make(map[string]*models.Emoji)}
}

func (s *statefulMockEmojiStore) CreateEmoji(_ context.Context, emoji *models.Emoji, _, maxServer int) (*models.Emoji, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	// Check server limit — returns (nil, nil) like the real store.
	serverCount := 0
	for _, e := range s.emojis {
		if e.ServerID == emoji.ServerID {
			serverCount++
		}
	}
	if maxServer > 0 && serverCount >= maxServer {
		return nil, nil
	}
	// Check for duplicate name in same server.
	for _, e := range s.emojis {
		if e.ServerID == emoji.ServerID && e.Name == emoji.Name {
			return nil, fmt.Errorf("duplicate key")
		}
	}
	s.emojis[emoji.ID] = emoji
	return emoji, nil
}

func (s *statefulMockEmojiStore) GetEmoji(_ context.Context, emojiID string) (*models.Emoji, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	e, ok := s.emojis[emojiID]
	if !ok {
		return nil, fmt.Errorf("not found")
	}
	return e, nil
}

func (s *statefulMockEmojiStore) ListEmojis(_ context.Context, serverID string) ([]*models.Emoji, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var emojis []*models.Emoji
	for _, e := range s.emojis {
		if e.ServerID == serverID {
			emojis = append(emojis, e)
		}
	}
	return emojis, nil
}

func (s *statefulMockEmojiStore) UpdateEmoji(_ context.Context, emojiID string, name *string) (*models.Emoji, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	e, ok := s.emojis[emojiID]
	if !ok {
		return nil, fmt.Errorf("not found")
	}
	if name != nil {
		// Check duplicate name.
		for _, other := range s.emojis {
			if other.ServerID == e.ServerID && other.Name == *name && other.ID != emojiID {
				return nil, fmt.Errorf("duplicate key")
			}
		}
		e.Name = *name
	}
	return e, nil
}

func (s *statefulMockEmojiStore) DeleteEmoji(_ context.Context, emojiID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.emojis[emojiID]; !ok {
		return fmt.Errorf("not found")
	}
	delete(s.emojis, emojiID)
	return nil
}

func (s *statefulMockEmojiStore) CountEmojisByServer(_ context.Context, serverID string) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	count := 0
	for _, e := range s.emojis {
		if e.ServerID == serverID {
			count++
		}
	}
	return count, nil
}
func (s *statefulMockEmojiStore) CountEmojisByUser(_ context.Context, _ string) (int, error) {
	return 0, nil
}
func (s *statefulMockEmojiStore) ListEmojisByUser(_ context.Context, _ string) ([]*models.Emoji, error) {
	return nil, nil
}

// setupEmojiTestServer creates a test server with a stateful emoji store.
func setupEmojiTestServer(t *testing.T) (mezav1connect.ChatServiceClient, *mockChatStore, *mockRoleStore, *statefulMockEmojiStore) {
	t.Helper()
	roleStore := newMockRoleStore()
	chatStore := newMockChatStore(roleStore)
	messageStore := newMockMessageStore()
	inviteStore := newMockInviteStore()
	banStore := newMockBanStore()
	pinStore := newMockPinStore()
	emojiStore := newStatefulMockEmojiStore()
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
	return client, chatStore, roleStore, emojiStore
}

// setupEmojiScenario creates a server with an owner who has ManageEmojis.
func setupEmojiScenario(t *testing.T) (mezav1connect.ChatServiceClient, string, string, *mockChatStore, *mockRoleStore, *statefulMockEmojiStore) {
	t.Helper()
	client, chatStore, roleStore, emojiStore := setupEmojiTestServer(t)

	ownerID := models.NewID()
	srvResp, err := client.CreateServer(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.CreateServerRequest{Name: "Emoji Server"}))
	if err != nil {
		t.Fatalf("CreateServer: %v", err)
	}
	serverID := srvResp.Msg.Server.Id

	return client, serverID, ownerID, chatStore, roleStore, emojiStore
}

// --- CreateEmoji tests ---

func TestCreateEmojiSuccess(t *testing.T) {
	client, serverID, ownerID, _, _, _ := setupEmojiScenario(t)

	resp, err := client.CreateEmoji(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.CreateEmojiRequest{
		ServerId:     serverID,
		Name:         "fire",
		AttachmentId: models.NewID(),
	}))
	if err != nil {
		t.Fatalf("CreateEmoji: %v", err)
	}
	if resp.Msg.Emoji == nil {
		t.Fatal("expected emoji in response")
	}
	if resp.Msg.Emoji.Name != "fire" {
		t.Errorf("name = %q, want %q", resp.Msg.Emoji.Name, "fire")
	}
}

func TestCreateEmojiNoPermission(t *testing.T) {
	client, serverID, _, chatStore, _, _ := setupEmojiScenario(t)

	noPermUserID := models.NewID()
	chatStore.AddMember(context.Background(), noPermUserID, serverID)

	_, err := client.CreateEmoji(context.Background(), testutil.AuthedRequest(t, noPermUserID, &v1.CreateEmojiRequest{
		ServerId:     serverID,
		Name:         "fire",
		AttachmentId: models.NewID(),
	}))
	if err == nil {
		t.Fatal("expected error for missing ManageEmojis")
	}
	if connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Errorf("code = %v, want PermissionDenied", connect.CodeOf(err))
	}
}

func TestCreateEmojiInvalidName(t *testing.T) {
	client, serverID, ownerID, _, _, _ := setupEmojiScenario(t)

	// Name with uppercase and special chars.
	_, err := client.CreateEmoji(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.CreateEmojiRequest{
		ServerId:     serverID,
		Name:         "Fire!!",
		AttachmentId: models.NewID(),
	}))
	if err == nil {
		t.Fatal("expected error for invalid name")
	}
	if connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Errorf("code = %v, want InvalidArgument", connect.CodeOf(err))
	}
}

func TestCreateEmojiInvalidNameTooShort(t *testing.T) {
	client, serverID, ownerID, _, _, _ := setupEmojiScenario(t)

	_, err := client.CreateEmoji(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.CreateEmojiRequest{
		ServerId:     serverID,
		Name:         "a",
		AttachmentId: models.NewID(),
	}))
	if err == nil {
		t.Fatal("expected error for too-short name")
	}
	if connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Errorf("code = %v, want InvalidArgument", connect.CodeOf(err))
	}
}

func TestCreateEmojiDuplicateName(t *testing.T) {
	client, serverID, ownerID, _, _, _ := setupEmojiScenario(t)

	// First emoji.
	_, err := client.CreateEmoji(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.CreateEmojiRequest{
		ServerId:     serverID,
		Name:         "fire",
		AttachmentId: models.NewID(),
	}))
	if err != nil {
		t.Fatalf("first CreateEmoji: %v", err)
	}

	// Duplicate name.
	_, err = client.CreateEmoji(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.CreateEmojiRequest{
		ServerId:     serverID,
		Name:         "fire",
		AttachmentId: models.NewID(),
	}))
	if err == nil {
		t.Fatal("expected error for duplicate name")
	}
	if connect.CodeOf(err) != connect.CodeAlreadyExists {
		t.Errorf("code = %v, want AlreadyExists", connect.CodeOf(err))
	}
}

func TestCreateEmojiServerLimit(t *testing.T) {
	client, serverID, ownerID, _, _, emojiStore := setupEmojiScenario(t)

	// Pre-populate 20 emojis.
	for i := 0; i < 20; i++ {
		emojiStore.mu.Lock()
		emojiStore.emojis[models.NewID()] = &models.Emoji{
			ID:        models.NewID(),
			ServerID:  serverID,
			Name:      fmt.Sprintf("emoji%d", i),
			CreatedAt: time.Now(),
		}
		emojiStore.mu.Unlock()
	}

	_, err := client.CreateEmoji(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.CreateEmojiRequest{
		ServerId:     serverID,
		Name:         "one_too_many",
		AttachmentId: models.NewID(),
	}))
	if err == nil {
		t.Fatal("expected error for server limit")
	}
	if connect.CodeOf(err) != connect.CodeResourceExhausted {
		t.Errorf("code = %v, want ResourceExhausted", connect.CodeOf(err))
	}
}

func TestCreateEmojiUnauthenticated(t *testing.T) {
	client, serverID, _, _, _, _ := setupEmojiScenario(t)

	_, err := client.CreateEmoji(context.Background(), connect.NewRequest(&v1.CreateEmojiRequest{
		ServerId:     serverID,
		Name:         "fire",
		AttachmentId: models.NewID(),
	}))
	if err == nil {
		t.Fatal("expected error for unauthenticated")
	}
	if connect.CodeOf(err) != connect.CodeUnauthenticated {
		t.Errorf("code = %v, want Unauthenticated", connect.CodeOf(err))
	}
}

// --- UpdateEmoji tests ---

func TestUpdateEmojiSuccess(t *testing.T) {
	client, serverID, ownerID, _, _, _ := setupEmojiScenario(t)

	// Create emoji first.
	createResp, err := client.CreateEmoji(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.CreateEmojiRequest{
		ServerId:     serverID,
		Name:         "old_name",
		AttachmentId: models.NewID(),
	}))
	if err != nil {
		t.Fatalf("CreateEmoji: %v", err)
	}
	emojiID := createResp.Msg.Emoji.Id

	newName := "new_name"
	resp, err := client.UpdateEmoji(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.UpdateEmojiRequest{
		EmojiId: emojiID,
		Name:    &newName,
	}))
	if err != nil {
		t.Fatalf("UpdateEmoji: %v", err)
	}
	if resp.Msg.Emoji.Name != "new_name" {
		t.Errorf("name = %q, want %q", resp.Msg.Emoji.Name, "new_name")
	}
}

func TestUpdateEmojiNoPermission(t *testing.T) {
	client, serverID, ownerID, chatStore, _, _ := setupEmojiScenario(t)

	createResp, err := client.CreateEmoji(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.CreateEmojiRequest{
		ServerId:     serverID,
		Name:         "protected",
		AttachmentId: models.NewID(),
	}))
	if err != nil {
		t.Fatalf("CreateEmoji: %v", err)
	}

	noPermUserID := models.NewID()
	chatStore.AddMember(context.Background(), noPermUserID, serverID)

	newName := "hacked"
	_, err = client.UpdateEmoji(context.Background(), testutil.AuthedRequest(t, noPermUserID, &v1.UpdateEmojiRequest{
		EmojiId: createResp.Msg.Emoji.Id,
		Name:    &newName,
	}))
	if err == nil {
		t.Fatal("expected error for missing ManageEmojis")
	}
	if connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Errorf("code = %v, want PermissionDenied", connect.CodeOf(err))
	}
}

func TestUpdateEmojiNotFound(t *testing.T) {
	client, _, ownerID, _, _, _ := setupEmojiScenario(t)

	newName := "ghost"
	_, err := client.UpdateEmoji(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.UpdateEmojiRequest{
		EmojiId: "nonexistent-emoji",
		Name:    &newName,
	}))
	if err == nil {
		t.Fatal("expected error for nonexistent emoji")
	}
	if connect.CodeOf(err) != connect.CodeNotFound {
		t.Errorf("code = %v, want NotFound", connect.CodeOf(err))
	}
}

func TestUpdateEmojiDuplicateName(t *testing.T) {
	client, serverID, ownerID, _, _, _ := setupEmojiScenario(t)

	// Create two emojis.
	client.CreateEmoji(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.CreateEmojiRequest{
		ServerId:     serverID,
		Name:         "first",
		AttachmentId: models.NewID(),
	}))
	createResp, _ := client.CreateEmoji(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.CreateEmojiRequest{
		ServerId:     serverID,
		Name:         "second",
		AttachmentId: models.NewID(),
	}))

	// Try to rename second to first.
	dupName := "first"
	_, err := client.UpdateEmoji(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.UpdateEmojiRequest{
		EmojiId: createResp.Msg.Emoji.Id,
		Name:    &dupName,
	}))
	if err == nil {
		t.Fatal("expected error for duplicate name")
	}
	if connect.CodeOf(err) != connect.CodeAlreadyExists {
		t.Errorf("code = %v, want AlreadyExists", connect.CodeOf(err))
	}
}

// --- DeleteEmoji tests ---

func TestDeleteEmojiSuccess(t *testing.T) {
	client, serverID, ownerID, _, _, emojiStore := setupEmojiScenario(t)

	createResp, err := client.CreateEmoji(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.CreateEmojiRequest{
		ServerId:     serverID,
		Name:         "doomed",
		AttachmentId: models.NewID(),
	}))
	if err != nil {
		t.Fatalf("CreateEmoji: %v", err)
	}

	_, err = client.DeleteEmoji(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.DeleteEmojiRequest{
		EmojiId: createResp.Msg.Emoji.Id,
	}))
	if err != nil {
		t.Fatalf("DeleteEmoji: %v", err)
	}

	// Verify deleted.
	_, err = emojiStore.GetEmoji(context.Background(), createResp.Msg.Emoji.Id)
	if err == nil {
		t.Error("expected emoji to be deleted")
	}
}

func TestDeleteEmojiNoPermission(t *testing.T) {
	client, serverID, ownerID, chatStore, _, _ := setupEmojiScenario(t)

	createResp, _ := client.CreateEmoji(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.CreateEmojiRequest{
		ServerId:     serverID,
		Name:         "protected",
		AttachmentId: models.NewID(),
	}))

	noPermUserID := models.NewID()
	chatStore.AddMember(context.Background(), noPermUserID, serverID)

	_, err := client.DeleteEmoji(context.Background(), testutil.AuthedRequest(t, noPermUserID, &v1.DeleteEmojiRequest{
		EmojiId: createResp.Msg.Emoji.Id,
	}))
	if err == nil {
		t.Fatal("expected error for missing ManageEmojis")
	}
	if connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Errorf("code = %v, want PermissionDenied", connect.CodeOf(err))
	}
}

func TestDeleteEmojiNotFound(t *testing.T) {
	client, _, ownerID, _, _, _ := setupEmojiScenario(t)

	_, err := client.DeleteEmoji(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.DeleteEmojiRequest{
		EmojiId: "nonexistent-emoji",
	}))
	if err == nil {
		t.Fatal("expected error for nonexistent emoji")
	}
	if connect.CodeOf(err) != connect.CodeNotFound {
		t.Errorf("code = %v, want NotFound", connect.CodeOf(err))
	}
}

// --- ListEmojis tests ---

func TestListEmojisSuccess(t *testing.T) {
	client, serverID, ownerID, _, _, _ := setupEmojiScenario(t)

	client.CreateEmoji(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.CreateEmojiRequest{
		ServerId:     serverID,
		Name:         "fire",
		AttachmentId: models.NewID(),
	}))
	client.CreateEmoji(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.CreateEmojiRequest{
		ServerId:     serverID,
		Name:         "ice",
		AttachmentId: models.NewID(),
	}))

	resp, err := client.ListEmojis(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.ListEmojisRequest{
		ServerId: serverID,
	}))
	if err != nil {
		t.Fatalf("ListEmojis: %v", err)
	}
	if len(resp.Msg.Emojis) != 2 {
		t.Errorf("emojis count = %d, want 2", len(resp.Msg.Emojis))
	}
}

func TestListEmojisNotMember(t *testing.T) {
	client, serverID, _, _, _, _ := setupEmojiScenario(t)

	outsiderID := models.NewID()
	_, err := client.ListEmojis(context.Background(), testutil.AuthedRequest(t, outsiderID, &v1.ListEmojisRequest{
		ServerId: serverID,
	}))
	if err == nil {
		t.Fatal("expected error for non-member")
	}
	if connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Errorf("code = %v, want PermissionDenied", connect.CodeOf(err))
	}
}
