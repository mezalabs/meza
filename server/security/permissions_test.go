//go:build integration

package security

import (
	"context"
	"testing"
	"time"

	"connectrpc.com/connect"
	v1 "github.com/meza-chat/meza/gen/meza/v1"
)

// TestPermissionCacheStaleWindow verifies that a user retains cached permissions
// after being kicked from a server.
//
// Severity: HIGH
// Finding: The permission cache has a 5-minute TTL in Redis. After a user is
// kicked or has their role revoked, they can continue performing actions using
// cached permissions for up to 5 minutes.
//
// Remediation: Call InvalidateUser synchronously on every membership change
// (kick, ban, role change, removal), or reduce the cache TTL to a few seconds.
func TestPermissionCacheStaleWindow(t *testing.T) {
	ctx := context.Background()
	suffix := uniqueSuffix(t)

	// Owner creates server + channel.
	owner := registerUser(t, "perm_own_"+suffix)
	serverID := mustCreateServer(t, owner.AccessToken)
	channelID := mustCreateChannel(t, owner.AccessToken, serverID)

	// Member joins the server.
	member := registerUser(t, "perm_mem_"+suffix)
	inviteCode := mustCreateInvite(t, owner.AccessToken, serverID)
	mustJoinServer(t, member.AccessToken, inviteCode)

	// Member sends a message to warm the permission cache.
	mustSendMessage(t, member.AccessToken, channelID, []byte("cache warming message"))

	// Owner kicks the member.
	chat := newChatClient()
	_, err := chat.KickMember(ctx, authedRequest(owner.AccessToken, &v1.KickMemberRequest{
		ServerId: serverID,
		UserId:   member.UserID,
	}))
	if err != nil {
		t.Fatalf("KickMember: %v", err)
	}

	// Immediately try to send a message as the kicked member.
	time.Sleep(100 * time.Millisecond) // Small delay for kick to propagate
	_, err = chat.SendMessage(ctx, authedRequest(member.AccessToken, &v1.SendMessageRequest{
		ChannelId:        channelID,
		EncryptedContent: []byte("post-kick message"),
		Nonce:            uniqueSuffix(t),
	}))
	if err == nil {
		t.Error("VULNERABILITY CONFIRMED: Kicked member can still send messages (stale permission cache)")
	} else {
		t.Logf("Mitigated: Kicked member correctly denied: %v", connect.CodeOf(err))
	}
}

// TestVoiceChannelOverrideBypass verifies that voice channel permission overrides
// are not checked by the voice service.
//
// Severity: HIGH
// Finding: JoinVoiceChannel checks server membership and evaluates permissions
// from role bitfields directly (via bitwise OR), completely bypassing the
// ResolveEffective function that handles channel-level overrides. A channel-level
// deny override for Connect has no effect.
//
// Remediation: Route JoinVoiceChannel permission check through the full
// ResolveEffective function that respects category -> channel -> role -> user overrides.
func TestVoiceChannelOverrideBypass(t *testing.T) {
	t.Skip("Cannot verify programmatically: the voice service uses direct bitwise OR on role " +
		"permissions instead of ResolveEffective, so channel-level deny overrides are ignored. " +
		"This test requires a CreateChannelOverride API (not yet available) to create a deny " +
		"override for the Connect permission on a voice channel. " +
		"Manual verification: (1) create a role with Connect allowed, (2) add a channel override " +
		"that denies Connect for that role on a voice channel, (3) observe that JoinVoiceChannel " +
		"still succeeds because the voice service never calls ResolveEffective.")
}

// TestSelfAssignableRoleEscalation verifies that self-assignable roles cannot
// be used to escalate privileges beyond the caller's current permission set.
//
// Severity: HIGH
// Finding: A self-assignable role with Administrator permission (bit 3) could
// allow any member to grant themselves full admin. The no-escalation check in
// SetMemberRoles should prevent this, but needs verification.
//
// Remediation: Ensure SetMemberRoles checks that the combined permissions of
// self-assigned roles don't exceed the caller's current permission set.
func TestSelfAssignableRoleEscalation(t *testing.T) {
	ctx := context.Background()
	suffix := uniqueSuffix(t)

	// Owner creates server.
	owner := registerUser(t, "sar_own_"+suffix)
	serverID := mustCreateServer(t, owner.AccessToken)
	chat := newChatClient()

	// Owner creates a self-assignable role with Administrator permission.
	const adminPermission int64 = 1 << 3 // Administrator bit
	roleResp, err := chat.CreateRole(ctx, authedRequest(owner.AccessToken, &v1.CreateRoleRequest{
		ServerId:         serverID,
		Name:             "Self-Admin-" + uniqueSuffix(t),
		Permissions:      adminPermission,
		IsSelfAssignable: true,
	}))
	if err != nil {
		t.Fatalf("CreateRole: %v", err)
	}
	roleID := roleResp.Msg.Role.Id

	// Member joins the server.
	member := registerUser(t, "sar_mem_"+suffix)
	inviteCode := mustCreateInvite(t, owner.AccessToken, serverID)
	mustJoinServer(t, member.AccessToken, inviteCode)

	// Member tries to self-assign the admin role.
	_, err = chat.SetMemberRoles(ctx, authedRequest(member.AccessToken, &v1.SetMemberRolesRequest{
		ServerId: serverID,
		UserId:   member.UserID,
		RoleIds:  []string{roleID},
	}))
	if err == nil {
		t.Error("VULNERABILITY CONFIRMED: Member self-assigned Administrator role via self-assignable role")
	} else {
		code := connect.CodeOf(err)
		if code == connect.CodePermissionDenied {
			t.Log("Mitigated: Self-assignment of admin role correctly denied")
		} else {
			t.Logf("Self-assignment rejected with code %v: %v", code, err)
		}
	}
}
