package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"connectrpc.com/connect"
	v1 "github.com/mezalabs/meza/gen/meza/v1"
	"github.com/mezalabs/meza/internal/auth"
	"github.com/mezalabs/meza/internal/models"
	"github.com/mezalabs/meza/internal/store"
	"github.com/mezalabs/meza/internal/testutil"
)

// TestGetDownloadURL_IDOR_CrossUserDenied verifies that an authenticated user
// cannot download a chat attachment they don't have access to.
func TestGetDownloadURL_IDOR_CrossUserDenied(t *testing.T) {
	ac := &mockAccessChecker{
		allowAll:     false,
		allowedUsers: map[string]map[string]bool{},
	}
	client, mockStore := setupTestMediaServerWithAccess(t, ac)

	now := time.Now()
	mockStore.attachments["att-owned-by-A"] = &models.Attachment{
		ID:            "att-owned-by-A",
		UploaderID:    "user-A",
		UploadPurpose: "chat_attachment",
		Status:        models.AttachmentStatusCompleted,
		ContentType:   "image/jpeg",
		CompletedAt:   &now,
	}

	// user-B requests the download URL — should be denied.
	_, err := client.GetDownloadURL(context.Background(), authedRequest(t, &v1.GetDownloadURLRequest{
		AttachmentId: "att-owned-by-A",
	}, "user-B"))

	if err == nil {
		t.Fatal("expected error for cross-user download")
	}
	if connect.CodeOf(err) != connect.CodeNotFound {
		t.Errorf("code = %v, want NotFound (to avoid leaking existence)", connect.CodeOf(err))
	}
}

// TestGetDownloadURL_IDOR_AuthorizedUserAllowed verifies that a user with
// access (e.g. channel member) can download a chat attachment.
func TestGetDownloadURL_IDOR_AuthorizedUserAllowed(t *testing.T) {
	ac := &mockAccessChecker{
		allowAll: false,
		allowedUsers: map[string]map[string]bool{
			"att-owned-by-A": {"user-B": true},
		},
	}
	client, mockStore := setupTestMediaServerWithAccess(t, ac)

	now := time.Now()
	mockStore.attachments["att-owned-by-A"] = &models.Attachment{
		ID:            "att-owned-by-A",
		UploaderID:    "user-A",
		UploadPurpose: "chat_attachment",
		Status:        models.AttachmentStatusCompleted,
		ContentType:   "image/jpeg",
		ObjectKey:     "uploads/user-A/att-owned-by-A/photo.jpg",
		Filename:      "photo.jpg",
		CompletedAt:   &now,
	}

	// user-B has access — should get past the access check (fails at S3).
	_, err := client.GetDownloadURL(context.Background(), authedRequest(t, &v1.GetDownloadURLRequest{
		AttachmentId: "att-owned-by-A",
	}, "user-B"))

	if err == nil {
		return // S3 stub succeeded — access confirmed
	}
	// Should be Internal (nil S3), NOT NotFound (access denied).
	if connect.CodeOf(err) == connect.CodeNotFound {
		t.Errorf("authorized user should not get NotFound, got %v", connect.CodeOf(err))
	}
}

// TestCompleteUpload_IDOR_OtherUsersUpload verifies that user-B cannot complete
// an upload that belongs to user-A. The TransitionToProcessing store method
// checks uploaderID, returning nil when it doesn't match.
func TestCompleteUpload_IDOR_OtherUsersUpload(t *testing.T) {
	client, mockStore := setupTestMediaServer(t)

	mockStore.attachments["att-A"] = &models.Attachment{
		ID:         "att-A",
		UploaderID: "user-A",
		Status:     models.AttachmentStatusPending,
	}

	_, err := client.CompleteUpload(context.Background(), authedRequest(t, &v1.CompleteUploadRequest{
		UploadId: "att-A",
	}, "user-B"))

	if err == nil {
		t.Fatal("expected error when user-B tries to complete user-A's upload")
	}
	if connect.CodeOf(err) != connect.CodeFailedPrecondition {
		t.Errorf("code = %v, want FailedPrecondition", connect.CodeOf(err))
	}
}

// TestCompleteUpload_IDOR_OwnerCanComplete verifies that the rightful owner
// passes the ownership check in TransitionToProcessing.
func TestCompleteUpload_IDOR_OwnerCanComplete(t *testing.T) {
	client, mockStore := setupTestMediaServer(t)

	mockStore.attachments["att-A"] = &models.Attachment{
		ID:          "att-A",
		UploaderID:  "user-A",
		ObjectKey:   "uploads/att-A/file.jpg",
		Status:      models.AttachmentStatusPending,
		ContentType: "image/jpeg",
	}

	_, err := client.CompleteUpload(context.Background(), authedRequest(t, &v1.CompleteUploadRequest{
		UploadId: "att-A",
	}, "user-A"))

	// The owner passes ownership check but S3 client is nil, so we expect an
	// internal error (NOT FailedPrecondition which would mean ownership failed).
	if err == nil {
		return // S3 stub succeeded — owner access confirmed
	}
	if connect.CodeOf(err) == connect.CodeFailedPrecondition {
		t.Errorf("owner should pass ownership check, but got FailedPrecondition")
	}
}

// TestMediaRedirect_IDOR_RequiresAuth verifies that the /media/ redirect endpoint
// is protected by RequireHTTPAuth middleware.
func TestMediaRedirect_IDOR_RequiresAuth(t *testing.T) {
	mockStore := newMockMediaStore()

	authMiddleware := auth.RequireHTTPAuth(testutil.TestEd25519Keys.PublicKey)
	handler := authMiddleware(mediaRedirectHandler(mockStore, newMockAccessChecker(), nil))

	mux := http.NewServeMux()
	mux.Handle("/media/", handler)

	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)

	resp, err := http.Get(server.URL + "/media/some-attachment-id")
	if err != nil {
		t.Fatalf("HTTP GET: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("status = %d, want %d (401 Unauthorized)", resp.StatusCode, http.StatusUnauthorized)
	}
}

// TestMediaRedirect_IDOR_AccessDenied verifies that the /media/ redirect endpoint
// denies access when the access checker rejects the user.
func TestMediaRedirect_IDOR_AccessDenied(t *testing.T) {
	mockStore := newMockMediaStore()
	ac := &mockAccessChecker{
		allowAll:     false,
		allowedUsers: map[string]map[string]bool{},
	}

	channelID := "channel-1"
	mockStore.attachments["att-secret"] = &models.Attachment{
		ID:            "att-secret",
		UploaderID:    "user-A",
		UploadPurpose: "chat_attachment",
		ChannelID:     &channelID,
		Status:        models.AttachmentStatusCompleted,
		ObjectKey:     "uploads/user-A/att-secret/doc.pdf",
		Filename:      "doc.pdf",
		ContentType:   "application/pdf",
	}

	authMiddleware := auth.RequireHTTPAuth(testutil.TestEd25519Keys.PublicKey)
	handler := authMiddleware(mediaRedirectHandler(mockStore, ac, nil))

	mux := http.NewServeMux()
	mux.Handle("/media/", handler)

	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)

	// Authenticated request from user-B who is NOT in the allowed list.
	token, _, err := auth.GenerateTokenPairEd25519("user-B", "dev", testutil.TestEd25519Keys, "", false)
	if err != nil {
		t.Fatalf("generating test token: %v", err)
	}
	req, _ := http.NewRequest(http.MethodGet, server.URL+"/media/att-secret", nil)
	req.Header.Set("Authorization", "Bearer "+token)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("HTTP GET: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("status = %d, want %d (404 Not Found — hides existence)", resp.StatusCode, http.StatusNotFound)
	}
}

// Compile-time check that mockAccessChecker satisfies the interface.
var _ store.MediaAccessChecker = (*mockAccessChecker)(nil)
