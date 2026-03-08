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
	"github.com/meza-chat/meza/internal/store"
	"github.com/meza-chat/meza/internal/testutil"
)

// mockMediaStore implements store.MediaStorer for testing.
type mockMediaStore struct {
	mu          sync.Mutex
	attachments map[string]*models.Attachment
}

func newMockMediaStore() *mockMediaStore {
	return &mockMediaStore{
		attachments: make(map[string]*models.Attachment),
	}
}

func (m *mockMediaStore) CreateAttachment(_ context.Context, a *models.Attachment) (*models.Attachment, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.attachments[a.ID] = a
	return a, nil
}

func (m *mockMediaStore) GetAttachment(_ context.Context, id string) (*models.Attachment, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	a, ok := m.attachments[id]
	if !ok {
		return nil, fmt.Errorf("attachment not found")
	}
	return a, nil
}

func (m *mockMediaStore) CountPendingByUploader(_ context.Context, uploaderID string) (int, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	count := 0
	for _, a := range m.attachments {
		if a.UploaderID == uploaderID && a.Status == models.AttachmentStatusPending {
			count++
		}
	}
	return count, nil
}

func (m *mockMediaStore) TransitionToProcessing(_ context.Context, id, uploaderID string) (*models.Attachment, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	a, ok := m.attachments[id]
	if !ok || a.UploaderID != uploaderID || a.Status != models.AttachmentStatusPending {
		return nil, nil
	}
	a.Status = models.AttachmentStatusProcessing
	return a, nil
}

func (m *mockMediaStore) UpdateAttachmentCompleted(_ context.Context, id string, sizeBytes int64, contentType string, width, height int, thumbnailKey string, microThumbnailData string, encryptedKey []byte) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	a, ok := m.attachments[id]
	if !ok {
		return fmt.Errorf("attachment not found")
	}
	if a.Status != models.AttachmentStatusProcessing {
		return fmt.Errorf("attachment %s not in processing state", id)
	}
	a.Status = models.AttachmentStatusCompleted
	a.SizeBytes = sizeBytes
	a.ContentType = contentType
	a.Width = width
	a.Height = height
	a.ThumbnailKey = thumbnailKey
	a.MicroThumbnailData = microThumbnailData
	now := time.Now()
	a.CompletedAt = &now
	a.ExpiresAt = nil
	return nil
}

func (m *mockMediaStore) DeleteAttachment(_ context.Context, id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.attachments, id)
	return nil
}

func (m *mockMediaStore) GetAttachmentsByIDs(_ context.Context, ids []string) (map[string]*models.Attachment, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	result := make(map[string]*models.Attachment, len(ids))
	for _, id := range ids {
		if a, ok := m.attachments[id]; ok {
			result[id] = a
		}
	}
	return result, nil
}

func (m *mockMediaStore) ResetAttachmentToPending(_ context.Context, _ string) error {
	return nil
}

func (m *mockMediaStore) LinkAttachments(_ context.Context, ids []string, channelID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	now := time.Now()
	for _, id := range ids {
		if a, ok := m.attachments[id]; ok {
			a.LinkedAt = &now
			a.ChannelID = &channelID
		}
	}
	return nil
}

func (m *mockMediaStore) FindUnlinkedAttachments(_ context.Context, olderThan time.Time, limit int) ([]*models.Attachment, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var unlinked []*models.Attachment
	for _, a := range m.attachments {
		if a.Status == models.AttachmentStatusCompleted && a.LinkedAt == nil &&
			a.UploadPurpose == "chat_attachment" &&
			a.CompletedAt != nil && a.CompletedAt.Before(olderThan) {
			unlinked = append(unlinked, a)
			if len(unlinked) >= limit {
				break
			}
		}
	}
	return unlinked, nil
}

func (m *mockMediaStore) NullifyChannelAttachments(_ context.Context, channelID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, a := range m.attachments {
		if a.ChannelID != nil && *a.ChannelID == channelID {
			a.ChannelID = nil
		}
	}
	return nil
}

func (m *mockMediaStore) FindOrphanedUploads(_ context.Context, before time.Time, limit int) ([]*models.Attachment, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var orphans []*models.Attachment
	for _, a := range m.attachments {
		if (a.Status == models.AttachmentStatusPending || a.Status == models.AttachmentStatusProcessing) &&
			a.ExpiresAt != nil && a.ExpiresAt.Before(before) {
			orphans = append(orphans, a)
			if len(orphans) >= limit {
				break
			}
		}
	}
	return orphans, nil
}

// mockAccessChecker implements store.MediaAccessChecker for testing.
type mockAccessChecker struct {
	// allowAll makes every check pass (default for existing tests).
	allowAll bool
	// allowedUsers maps attachmentID → set of userIDs that have access.
	allowedUsers map[string]map[string]bool
}

func newMockAccessChecker() *mockAccessChecker {
	return &mockAccessChecker{allowAll: true}
}

func (m *mockAccessChecker) CheckAttachmentAccess(_ context.Context, attachment *models.Attachment, userID string) error {
	if m.allowAll {
		return nil
	}
	// Mirror real behavior: public purposes are always allowed.
	switch attachment.UploadPurpose {
	case "profile_avatar", "profile_banner", "server_icon", "server_banner":
		return nil
	}
	if users, ok := m.allowedUsers[attachment.ID]; ok && users[userID] {
		return nil
	}
	return store.ErrNotFound
}

// setupTestMediaServer creates an httptest server with the media service.
// The S3 client is nil, which means tests that reach S3 calls will fail.
// Validation tests (which return errors before S3) will work.
func setupTestMediaServer(t *testing.T) (mezav1connect.MediaServiceClient, *mockMediaStore) {
	t.Helper()
	mockStore := newMockMediaStore()
	svc := newMediaService(mockStore, newMockAccessChecker(), nil, nil) // nil S3 — validation-only tests

	mux := http.NewServeMux()
	path, handler := mezav1connect.NewMediaServiceHandler(svc,
		connect.WithInterceptors(auth.NewConnectInterceptor(testutil.TestEd25519Keys.PublicKey)),
	)
	mux.Handle(path, handler)

	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)

	client := mezav1connect.NewMediaServiceClient(http.DefaultClient, server.URL)
	return client, mockStore
}

func authedRequest[T any](t *testing.T, msg *T, userID string) *connect.Request[T] {
	t.Helper()
	token, _, err := auth.GenerateTokenPairEd25519(userID, "test-device", testutil.TestEd25519Keys, "", false)
	if err != nil {
		t.Fatalf("generating test token: %v", err)
	}
	req := connect.NewRequest(msg)
	req.Header().Set("Authorization", "Bearer "+token)
	return req
}

func TestCreateUpload_Unauthenticated(t *testing.T) {
	client, _ := setupTestMediaServer(t)
	_, err := client.CreateUpload(context.Background(), connect.NewRequest(&v1.CreateUploadRequest{
		Filename:    "test.jpg",
		ContentType: "image/jpeg",
		SizeBytes:   1024,
	}))
	if err == nil {
		t.Fatal("expected error for unauthenticated request")
	}
	if connect.CodeOf(err) != connect.CodeUnauthenticated {
		t.Errorf("code = %v, want Unauthenticated", connect.CodeOf(err))
	}
}

func TestCreateUpload_MissingFilename(t *testing.T) {
	client, _ := setupTestMediaServer(t)
	_, err := client.CreateUpload(context.Background(), authedRequest(t, &v1.CreateUploadRequest{
		ContentType: "image/jpeg",
		SizeBytes:   1024,
	}, "user-1"))
	if err == nil {
		t.Fatal("expected error for missing filename")
	}
	if connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Errorf("code = %v, want InvalidArgument", connect.CodeOf(err))
	}
}

func TestCreateUpload_BadContentType(t *testing.T) {
	client, _ := setupTestMediaServer(t)
	_, err := client.CreateUpload(context.Background(), authedRequest(t, &v1.CreateUploadRequest{
		Filename:    "test.exe",
		ContentType: "application/x-executable",
		SizeBytes:   1024,
	}, "user-1"))
	if err == nil {
		t.Fatal("expected error for unsupported content type")
	}
	if connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Errorf("code = %v, want InvalidArgument", connect.CodeOf(err))
	}
}

func TestCreateUpload_SizeTooLarge(t *testing.T) {
	client, _ := setupTestMediaServer(t)
	_, err := client.CreateUpload(context.Background(), authedRequest(t, &v1.CreateUploadRequest{
		Filename:    "test.jpg",
		ContentType: "image/jpeg",
		SizeBytes:   maxFileSize + 1,
	}, "user-1"))
	if err == nil {
		t.Fatal("expected error for size too large")
	}
	if connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Errorf("code = %v, want InvalidArgument", connect.CodeOf(err))
	}
}

func TestCreateUpload_TooManyPending(t *testing.T) {
	client, mockStore := setupTestMediaServer(t)

	// Pre-fill the store with max pending uploads for user-1.
	for i := 0; i < maxPendingUploads; i++ {
		mockStore.attachments[fmt.Sprintf("att-%d", i)] = &models.Attachment{
			ID:         fmt.Sprintf("att-%d", i),
			UploaderID: "user-1",
			Status:     models.AttachmentStatusPending,
		}
	}

	_, err := client.CreateUpload(context.Background(), authedRequest(t, &v1.CreateUploadRequest{
		Filename:    "test.jpg",
		ContentType: "image/jpeg",
		SizeBytes:   1024,
	}, "user-1"))
	if err == nil {
		t.Fatal("expected error for too many pending uploads")
	}
	if connect.CodeOf(err) != connect.CodeResourceExhausted {
		t.Errorf("code = %v, want ResourceExhausted", connect.CodeOf(err))
	}
}

func TestCompleteUpload_Unauthenticated(t *testing.T) {
	client, _ := setupTestMediaServer(t)
	_, err := client.CompleteUpload(context.Background(), connect.NewRequest(&v1.CompleteUploadRequest{
		UploadId: "some-id",
	}))
	if err == nil {
		t.Fatal("expected error")
	}
	if connect.CodeOf(err) != connect.CodeUnauthenticated {
		t.Errorf("code = %v, want Unauthenticated", connect.CodeOf(err))
	}
}

func TestCompleteUpload_MissingUploadID(t *testing.T) {
	client, _ := setupTestMediaServer(t)
	_, err := client.CompleteUpload(context.Background(), authedRequest(t, &v1.CompleteUploadRequest{}, "user-1"))
	if err == nil {
		t.Fatal("expected error for missing upload_id")
	}
	if connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Errorf("code = %v, want InvalidArgument", connect.CodeOf(err))
	}
}

func TestCompleteUpload_NotFound(t *testing.T) {
	client, _ := setupTestMediaServer(t)
	_, err := client.CompleteUpload(context.Background(), authedRequest(t, &v1.CompleteUploadRequest{
		UploadId: "nonexistent",
	}, "user-1"))
	if err == nil {
		t.Fatal("expected error for nonexistent upload")
	}
	if connect.CodeOf(err) != connect.CodeFailedPrecondition {
		t.Errorf("code = %v, want FailedPrecondition", connect.CodeOf(err))
	}
}

func TestGetDownloadURL_Unauthenticated(t *testing.T) {
	client, _ := setupTestMediaServer(t)
	_, err := client.GetDownloadURL(context.Background(), connect.NewRequest(&v1.GetDownloadURLRequest{
		AttachmentId: "some-id",
	}))
	if err == nil {
		t.Fatal("expected error")
	}
	if connect.CodeOf(err) != connect.CodeUnauthenticated {
		t.Errorf("code = %v, want Unauthenticated", connect.CodeOf(err))
	}
}

func TestGetDownloadURL_NotFound(t *testing.T) {
	client, _ := setupTestMediaServer(t)
	_, err := client.GetDownloadURL(context.Background(), authedRequest(t, &v1.GetDownloadURLRequest{
		AttachmentId: "nonexistent",
	}, "user-1"))
	if err == nil {
		t.Fatal("expected error")
	}
	if connect.CodeOf(err) != connect.CodeNotFound {
		t.Errorf("code = %v, want NotFound", connect.CodeOf(err))
	}
}

func TestGetDownloadURL_NotCompleted(t *testing.T) {
	client, mockStore := setupTestMediaServer(t)
	mockStore.attachments["att-1"] = &models.Attachment{
		ID:     "att-1",
		Status: models.AttachmentStatusPending,
	}

	_, err := client.GetDownloadURL(context.Background(), authedRequest(t, &v1.GetDownloadURLRequest{
		AttachmentId: "att-1",
	}, "user-1"))
	if err == nil {
		t.Fatal("expected error for pending attachment")
	}
	if connect.CodeOf(err) != connect.CodeFailedPrecondition {
		t.Errorf("code = %v, want FailedPrecondition", connect.CodeOf(err))
	}
}

func TestMediaRedirectHandler_NotFound(t *testing.T) {
	mockStore := newMockMediaStore()
	handler := mediaRedirectHandler(mockStore, newMockAccessChecker(), nil)

	req := httptest.NewRequest(http.MethodGet, "/media/nonexistent", nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusNotFound {
		t.Errorf("status = %d, want %d", w.Code, http.StatusNotFound)
	}
}

func TestMediaRedirectHandler_NotCompleted(t *testing.T) {
	mockStore := newMockMediaStore()
	mockStore.attachments["att-1"] = &models.Attachment{
		ID:     "att-1",
		Status: models.AttachmentStatusPending,
	}

	handler := mediaRedirectHandler(mockStore, newMockAccessChecker(), nil)
	req := httptest.NewRequest(http.MethodGet, "/media/att-1", nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusNotFound {
		t.Errorf("status = %d, want %d", w.Code, http.StatusNotFound)
	}
}

func TestSanitizeFilename(t *testing.T) {
	tests := []struct {
		input string
		want  string
	}{
		{"photo.jpg", "photo.jpg"},
		{"../../../etc/passwd", "passwd"},
		{"/absolute/path/image.png", "image.png"},
		{"", "upload"},
		{".", "upload"},
		{"..", ".."},
		{"file\x00name.jpg", "filename.jpg"},
		{`file"name.jpg`, "filename.jpg"},
		{"file\nname.jpg", "filename.jpg"},
		{"normal-file_2024.webp", "normal-file_2024.webp"},
	}
	for _, tt := range tests {
		if got := sanitizeFilename(tt.input); got != tt.want {
			t.Errorf("sanitizeFilename(%q) = %q, want %q", tt.input, got, tt.want)
		}
	}
}

func TestPurposeToString(t *testing.T) {
	tests := []struct {
		input v1.UploadPurpose
		want  string
	}{
		{v1.UploadPurpose_UPLOAD_PURPOSE_UNSPECIFIED, "chat_attachment"},
		{v1.UploadPurpose_UPLOAD_PURPOSE_CHAT_ATTACHMENT, "chat_attachment"},
		{v1.UploadPurpose_UPLOAD_PURPOSE_PROFILE_AVATAR, "profile_avatar"},
		{v1.UploadPurpose_UPLOAD_PURPOSE_PROFILE_BANNER, "profile_banner"},
		{v1.UploadPurpose_UPLOAD_PURPOSE_SERVER_ICON, "server_icon"},
	}
	for _, tt := range tests {
		if got := purposeToString(tt.input); got != tt.want {
			t.Errorf("purposeToString(%v) = %q, want %q", tt.input, got, tt.want)
		}
	}
}

// --- Authorization tests ---

func setupTestMediaServerWithAccess(t *testing.T, ac *mockAccessChecker) (mezav1connect.MediaServiceClient, *mockMediaStore) {
	t.Helper()
	mockStore := newMockMediaStore()
	svc := newMediaService(mockStore, ac, nil, nil)

	mux := http.NewServeMux()
	path, handler := mezav1connect.NewMediaServiceHandler(svc,
		connect.WithInterceptors(auth.NewConnectInterceptor(testutil.TestEd25519Keys.PublicKey)),
	)
	mux.Handle(path, handler)

	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)

	client := mezav1connect.NewMediaServiceClient(http.DefaultClient, server.URL)
	return client, mockStore
}

func TestGetDownloadURL_AccessDenied(t *testing.T) {
	ac := &mockAccessChecker{
		allowAll:     false,
		allowedUsers: map[string]map[string]bool{},
	}
	client, mockStore := setupTestMediaServerWithAccess(t, ac)

	mockStore.attachments["att-1"] = &models.Attachment{
		ID:            "att-1",
		UploaderID:    "user-owner",
		UploadPurpose: "chat_attachment",
		Status:        models.AttachmentStatusCompleted,
	}

	_, err := client.GetDownloadURL(context.Background(), authedRequest(t, &v1.GetDownloadURLRequest{
		AttachmentId: "att-1",
	}, "user-other"))
	if err == nil {
		t.Fatal("expected error for unauthorized access")
	}
	if connect.CodeOf(err) != connect.CodeNotFound {
		t.Errorf("code = %v, want NotFound", connect.CodeOf(err))
	}
}

func TestGetDownloadURL_AccessAllowed(t *testing.T) {
	ac := &mockAccessChecker{
		allowAll: false,
		allowedUsers: map[string]map[string]bool{
			"att-1": {"user-member": true},
		},
	}
	client, mockStore := setupTestMediaServerWithAccess(t, ac)

	mockStore.attachments["att-1"] = &models.Attachment{
		ID:            "att-1",
		UploaderID:    "user-owner",
		UploadPurpose: "chat_attachment",
		Status:        models.AttachmentStatusCompleted,
		ObjectKey:     "uploads/user-owner/att-1/test.jpg",
		Filename:      "test.jpg",
		ContentType:   "image/jpeg",
	}

	// This will fail at S3 presign (nil client), but if it gets past the access
	// check it means authorization succeeded. The error must NOT be NotFound.
	_, err := client.GetDownloadURL(context.Background(), authedRequest(t, &v1.GetDownloadURLRequest{
		AttachmentId: "att-1",
	}, "user-member"))
	if err == nil {
		return // S3 stub succeeded — access confirmed
	}
	// Any error other than NotFound means we passed the access check.
	if connect.CodeOf(err) == connect.CodeNotFound {
		t.Errorf("authorized user got NotFound — access check wrongly denied")
	}
}

func TestGetDownloadURL_PublicPurposeAlwaysAllowed(t *testing.T) {
	// Even with restrictive access checker, public purposes pass.
	ac := &mockAccessChecker{
		allowAll:     false,
		allowedUsers: map[string]map[string]bool{},
	}

	for _, purpose := range []string{"profile_avatar", "profile_banner", "server_icon"} {
		t.Run(purpose, func(t *testing.T) {
			client, mockStore := setupTestMediaServerWithAccess(t, ac)

			mockStore.attachments["att-pub"] = &models.Attachment{
				ID:            "att-pub",
				UploaderID:    "user-owner",
				UploadPurpose: purpose,
				Status:        models.AttachmentStatusCompleted,
				ObjectKey:     "uploads/user-owner/att-pub/icon.png",
				Filename:      "icon.png",
				ContentType:   "image/png",
			}

			_, err := client.GetDownloadURL(context.Background(), authedRequest(t, &v1.GetDownloadURLRequest{
				AttachmentId: "att-pub",
			}, "user-random"))
			if err == nil {
				return // S3 stub succeeded — access confirmed
			}
			// Any error other than NotFound means we passed the access check.
			if connect.CodeOf(err) == connect.CodeNotFound {
				t.Errorf("public purpose %s got NotFound — should be accessible to any user", purpose)
			}
		})
	}
}

func TestMediaRedirectHandler_AccessDenied(t *testing.T) {
	mockStore := newMockMediaStore()
	ac := &mockAccessChecker{
		allowAll:     false,
		allowedUsers: map[string]map[string]bool{},
	}

	channelID := "channel-1"
	mockStore.attachments["att-1"] = &models.Attachment{
		ID:            "att-1",
		UploaderID:    "user-owner",
		UploadPurpose: "chat_attachment",
		ChannelID:     &channelID,
		Status:        models.AttachmentStatusCompleted,
		ObjectKey:     "uploads/user-owner/att-1/test.jpg",
		Filename:      "test.jpg",
		ContentType:   "image/jpeg",
	}

	handler := mediaRedirectHandler(mockStore, ac, nil)
	req := httptest.NewRequest(http.MethodGet, "/media/att-1", nil)
	// Inject authenticated user into context.
	ctx := auth.ContextWithUserID(req.Context(), "user-other")
	req = req.WithContext(ctx)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusNotFound {
		t.Errorf("status = %d, want %d", w.Code, http.StatusNotFound)
	}
}

func TestCleanupOrphans(t *testing.T) {
	mockStore := newMockMediaStore()

	past := time.Now().Add(-1 * time.Hour)
	mockStore.attachments["orphan-1"] = &models.Attachment{
		ID:        "orphan-1",
		Status:    models.AttachmentStatusPending,
		ExpiresAt: &past,
	}
	mockStore.attachments["valid-1"] = &models.Attachment{
		ID:     "valid-1",
		Status: models.AttachmentStatusCompleted,
	}

	// Run cleanup — S3 client is nil but ObjectKey is empty, so no S3 call.
	cleanupOrphans(context.Background(), mockStore, nil)

	if _, err := mockStore.GetAttachment(context.Background(), "orphan-1"); err == nil {
		t.Error("expected orphan-1 to be deleted")
	}
	if _, err := mockStore.GetAttachment(context.Background(), "valid-1"); err != nil {
		t.Error("expected valid-1 to still exist")
	}
}

// Ensure mockMediaStore satisfies the interface at compile time.
var _ store.MediaStorer = (*mockMediaStore)(nil)
