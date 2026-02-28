package main

import (
	"context"
	"testing"

	"connectrpc.com/connect"
	v1 "github.com/meza-chat/meza/gen/meza/v1"
	"github.com/meza-chat/meza/internal/testutil"
)

// TestGetPublicKeys_IDOR_AnyUserCanFetch documents the E2EE design decision that
// any authenticated user can fetch any other user's public signing key. This is
// fundamental to E2EE: clients need public keys to encrypt channel keys for
// other members.
func TestGetPublicKeys_IDOR_AnyUserCanFetch(t *testing.T) {
	env := setupTestEnv(t)

	// Seed a public key for user-A.
	env.keyStore.publicKeys["user-A"] = make([]byte, 32)
	env.keyStore.publicKeys["user-A"][0] = 0xAA

	// user-B (unrelated) can fetch user-A's public key.
	resp, err := env.client.GetPublicKeys(
		context.Background(),
		testutil.AuthedRequest(t, "user-B", &v1.GetPublicKeysRequest{
			UserIds: []string{"user-A"},
		}),
	)
	if err != nil {
		t.Fatalf("GetPublicKeys: %v", err)
	}

	keys := resp.Msg.PublicKeys
	if len(keys) != 1 {
		t.Fatalf("expected 1 key, got %d", len(keys))
	}
	if keys["user-A"][0] != 0xAA {
		t.Error("public key content mismatch")
	}
}

// TestStoreKeyEnvelopes_IDOR_RequiresViewChannel verifies that a user without
// ViewChannel permission on a channel cannot store key envelopes for that channel.
// This is the primary IDOR protection for key distribution: only users who can
// see the channel can participate in its encryption.
func TestStoreKeyEnvelopes_IDOR_RequiresViewChannel(t *testing.T) {
	env := setupTestEnv(t)

	// user-attacker does NOT have ViewChannel on ch-1.
	_, err := env.client.StoreKeyEnvelopes(
		context.Background(),
		testutil.AuthedRequest(t, "user-attacker", &v1.StoreKeyEnvelopesRequest{
			ChannelId:  "ch-1",
			KeyVersion: 1,
			Envelopes:  []*v1.KeyEnvelope{makeEnvelope("user-attacker")},
		}),
	)
	if err == nil {
		t.Fatal("expected error for user without ViewChannel")
	}
	if connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Errorf("code = %v, want PermissionDenied", connect.CodeOf(err))
	}
}
