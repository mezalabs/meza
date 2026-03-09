//go:build integration

package security

import (
	"context"
	"testing"

	"connectrpc.com/connect"
	v1 "github.com/mezalabs/meza/gen/meza/v1"
)

// TestBulkPresenceEnumeration verifies that GetBulkPresence does not check
// whether the caller has a relationship with the queried users.
//
// Severity: MEDIUM
// Finding: GetBulkPresence accepts up to 200 user_ids without verifying the
// caller shares a server with them. Any authenticated user can determine the
// online/offline status of arbitrary users, enabling user enumeration.
//
// Remediation: Filter GetBulkPresence results to only return presence for
// users who share at least one server with the caller.
func TestBulkPresenceEnumeration(t *testing.T) {
	ctx := context.Background()
	suffix := uniqueSuffix(t)

	// Register two users with no shared servers.
	userA := registerUser(t, "pres_a_"+suffix)
	userB := registerUser(t, "pres_b_"+suffix)

	presence := newPresenceClient()

	// User A queries User B's presence (no relationship exists).
	resp, err := presence.GetBulkPresence(ctx, authedRequest(userA.AccessToken, &v1.GetBulkPresenceRequest{
		UserIds: []string{userB.UserID},
	}))
	if err != nil {
		code := connect.CodeOf(err)
		if code == connect.CodePermissionDenied {
			t.Log("Mitigated: GetBulkPresence requires relationship check")
			return
		}
		t.Fatalf("GetBulkPresence: %v", err)
	}

	// If we got presence data back, the service didn't filter by relationship.
	if len(resp.Msg.Presences) > 0 {
		t.Error("VULNERABILITY: GetBulkPresence returns presence data for users with no relationship to caller")
	} else {
		t.Log("GetBulkPresence returned empty presences for unrelated user — may be filtered or user offline")
	}

	// Test the 200-item limit enforcement.
	manyIDs := make([]string, 201)
	for i := range manyIDs {
		manyIDs[i] = "fake-user-" + uniqueSuffix(t)
	}
	_, err = presence.GetBulkPresence(ctx, authedRequest(userA.AccessToken, &v1.GetBulkPresenceRequest{
		UserIds: manyIDs,
	}))
	if err == nil {
		t.Error("VULNERABILITY: GetBulkPresence accepted 201 user_ids (limit should be 200)")
	} else {
		code := connect.CodeOf(err)
		if code == connect.CodeInvalidArgument || code == connect.CodeResourceExhausted {
			t.Logf("Mitigated: 201 user_ids correctly rejected with %v", code)
		} else {
			t.Logf("201 user_ids rejected with unexpected code %v", code)
		}
	}
}
