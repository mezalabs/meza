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
	"github.com/meza-chat/meza/internal/testutil"
)

// TestGetDownloadURL_IDOR_AnyAuthUserCanAccess documents that any authenticated
// user can request a download URL for any completed attachment. This is by design:
// all content is E2EE and attachment IDs are unguessable ULIDs, so the download
// URL alone does not reveal plaintext content.
func TestGetDownloadURL_IDOR_AnyAuthUserCanAccess(t *testing.T) {
	client, mockStore := setupTestMediaServer(t)

	// user-A owns the attachment.
	now := time.Now()
	mockStore.attachments["att-owned-by-A"] = &models.Attachment{
		ID:          "att-owned-by-A",
		UploaderID:  "user-A",
		Status:      models.AttachmentStatusCompleted,
		ContentType: "image/jpeg",
		CompletedAt: &now,
	}

	// user-B requests the download URL — should succeed (E2EE makes this safe).
	// The handler will try to generate a presigned S3 URL (nil client → error),
	// but reaching that point means the auth/ownership check passed.
	_, err := client.GetDownloadURL(context.Background(), authedRequest(t, &v1.GetDownloadURLRequest{
		AttachmentId: "att-owned-by-A",
	}, "user-B"))

	// We expect an internal error because the S3 client is nil, NOT a
	// permission error. This proves any auth'd user can access completed attachments.
	if err == nil {
		// If the service has a non-nil S3 client in the future, success is acceptable.
		return
	}
	if connect.CodeOf(err) == connect.CodePermissionDenied || connect.CodeOf(err) == connect.CodeUnauthenticated {
		t.Errorf("expected no authz barrier for cross-user download, got %v", connect.CodeOf(err))
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
// passes the ownership check in TransitionToProcessing. The test will reach
// the S3 processing stage (nil client → panic caught or error), proving the
// ownership gate was passed.
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
// is protected by RequireHTTPAuth middleware. An unauthenticated request must
// receive 401 Unauthorized.
func TestMediaRedirect_IDOR_RequiresAuth(t *testing.T) {
	mockStore := newMockMediaStore()

	// Wire up the redirect handler with RequireHTTPAuth middleware, exactly as main.go does.
	authMiddleware := auth.RequireHTTPAuth(testutil.TestEd25519Keys.PublicKey)
	handler := authMiddleware(mediaRedirectHandler(mockStore, nil))

	mux := http.NewServeMux()
	mux.Handle("/media/", handler)

	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)

	client := mezav1connect.NewMediaServiceClient(http.DefaultClient, server.URL)
	_ = client // not used — we make a raw HTTP request instead

	// Raw GET with no Authorization header.
	resp, err := http.Get(server.URL + "/media/some-attachment-id")
	if err != nil {
		t.Fatalf("HTTP GET: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("status = %d, want %d (401 Unauthorized)", resp.StatusCode, http.StatusUnauthorized)
	}
}
