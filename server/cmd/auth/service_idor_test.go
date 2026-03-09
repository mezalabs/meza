package main

import (
	"context"
	"testing"
	"time"

	"connectrpc.com/connect"
	v1 "github.com/mezalabs/meza/gen/meza/v1"
	"github.com/mezalabs/meza/internal/models"
	"github.com/mezalabs/meza/internal/testutil"
)

// TestGetProfile_IDOR_OtherUserProfileAccessible documents the design decision
// that user profiles are public. Any authenticated user can fetch another user's
// profile. This is intentional: profiles contain only public information
// (username, display name, avatar, bio, etc.).
func TestGetProfile_IDOR_OtherUserProfileAccessible(t *testing.T) {
	client, mockStore := setupTestServer(t)

	// Create user-A directly in the store.
	userA := &models.User{
		ID:          models.NewID(),
		Email:       "alice@example.com",
		Username:    "alice",
		DisplayName: "Alice",
		DMPrivacy:   "friends_only",
		CreatedAt:   time.Now(),
	}
	mockStore.mu.Lock()
	mockStore.users[userA.ID] = userA
	mockStore.mu.Unlock()

	// user-B fetches user-A's profile — should succeed.
	userBID := models.NewID()
	resp, err := client.GetProfile(context.Background(), testutil.AuthedRequest(t, userBID, &v1.GetProfileRequest{
		UserId: userA.ID,
	}))
	if err != nil {
		t.Fatalf("GetProfile: %v", err)
	}
	if resp.Msg.User.Username != "alice" {
		t.Errorf("username = %q, want %q", resp.Msg.User.Username, "alice")
	}
}

// TestGetProfile_IDOR_DmPrivacyRedactedForOthers verifies that the dm_privacy
// field is stripped from profiles when viewed by other users, but present when
// viewing your own profile. This prevents information leakage about a user's
// DM privacy setting.
func TestGetProfile_IDOR_DmPrivacyRedactedForOthers(t *testing.T) {
	client, mockStore := setupTestServer(t)

	userA := &models.User{
		ID:          models.NewID(),
		Email:       "alice@example.com",
		Username:    "alice",
		DisplayName: "Alice",
		DMPrivacy:   "friends_only",
		CreatedAt:   time.Now(),
	}
	mockStore.mu.Lock()
	mockStore.users[userA.ID] = userA
	mockStore.mu.Unlock()

	// user-A views their own profile — dm_privacy should be present.
	selfResp, err := client.GetProfile(context.Background(), testutil.AuthedRequest(t, userA.ID, &v1.GetProfileRequest{
		UserId: userA.ID,
	}))
	if err != nil {
		t.Fatalf("GetProfile (self): %v", err)
	}
	if selfResp.Msg.User.DmPrivacy != "friends_only" {
		t.Errorf("self dm_privacy = %q, want %q", selfResp.Msg.User.DmPrivacy, "friends_only")
	}

	// user-B views user-A's profile — dm_privacy should be empty.
	userBID := models.NewID()
	otherResp, err := client.GetProfile(context.Background(), testutil.AuthedRequest(t, userBID, &v1.GetProfileRequest{
		UserId: userA.ID,
	}))
	if err != nil {
		t.Fatalf("GetProfile (other): %v", err)
	}
	if otherResp.Msg.User.DmPrivacy != "" {
		t.Errorf("other dm_privacy = %q, want empty (redacted)", otherResp.Msg.User.DmPrivacy)
	}
}

// TestGetProfile_IDOR_NonexistentUser verifies that fetching a profile for a
// non-existent user returns CodeNotFound, not a panic or internal error.
func TestGetProfile_IDOR_NonexistentUser(t *testing.T) {
	client, _ := setupTestServer(t)

	userBID := models.NewID()
	_, err := client.GetProfile(context.Background(), testutil.AuthedRequest(t, userBID, &v1.GetProfileRequest{
		UserId: "nonexistent-user-id",
	}))
	if err == nil {
		t.Fatal("expected error for nonexistent user")
	}
	if connect.CodeOf(err) != connect.CodeNotFound {
		t.Errorf("code = %v, want NotFound", connect.CodeOf(err))
	}
}
