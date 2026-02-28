package main

import (
	"context"
	"testing"

	"connectrpc.com/connect"
	v1 "github.com/meza-chat/meza/gen/meza/v1"
	"github.com/meza-chat/meza/gen/meza/v1/mezav1connect"
	"github.com/meza-chat/meza/internal/models"
	"github.com/meza-chat/meza/internal/permissions"
	"github.com/meza-chat/meza/internal/testutil"
)

// setupModerationScenario creates a server with owner, admin (KickMembers+BanMembers),
// and target members with appropriate role hierarchy for moderation tests.
func setupModerationScenario(t *testing.T) (client testClient, serverID, ownerID, adminID, targetID string, chatStore *mockChatStore, roleStore *mockRoleStore, banStore *mockBanStore) {
	t.Helper()
	c, cs, rs, bs := setupModerationTestServer(t)

	ownerID = models.NewID()
	adminID = models.NewID()
	targetID = models.NewID()

	// Create server (owner auto-added as member).
	srvResp, err := c.CreateServer(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.CreateServerRequest{Name: "Test Server"}))
	if err != nil {
		t.Fatalf("CreateServer: %v", err)
	}
	serverID = srvResp.Msg.Server.Id

	// Add admin and target as members.
	cs.AddMember(context.Background(), adminID, serverID)
	cs.AddMember(context.Background(), targetID, serverID)

	// Create admin role (position 10, KickMembers+BanMembers+ManageRoles).
	adminRoleID := models.NewID()
	rs.CreateRole(context.Background(), &models.Role{
		ID:          adminRoleID,
		ServerID:    serverID,
		Name:        "Admin",
		Position:    10,
		Permissions: permissions.KickMembers | permissions.BanMembers | permissions.ManageRoles,
	})

	// Create low role (position 5, KickMembers only).
	lowRoleID := models.NewID()
	rs.CreateRole(context.Background(), &models.Role{
		ID:          lowRoleID,
		ServerID:    serverID,
		Name:        "Moderator",
		Position:    5,
		Permissions: permissions.KickMembers | permissions.BanMembers,
	})

	// Assign admin role to admin, low role to target.
	rs.assignRoles(serverID, adminID, []string{adminRoleID})
	rs.assignRoles(serverID, targetID, []string{lowRoleID})

	return c, serverID, ownerID, adminID, targetID, cs, rs, bs
}

type testClient = mezav1connect.ChatServiceClient

// --- KickMember tests ---

func TestKickMemberSuccess(t *testing.T) {
	client, serverID, _, adminID, targetID, chatStore, _, _ := setupModerationScenario(t)

	_, err := client.KickMember(context.Background(), testutil.AuthedRequest(t, adminID, &v1.KickMemberRequest{
		ServerId: serverID,
		UserId:   targetID,
	}))
	if err != nil {
		t.Fatalf("KickMember: %v", err)
	}

	// Verify member was removed.
	isMember, _ := chatStore.IsMember(context.Background(), targetID, serverID)
	if isMember {
		t.Error("expected target to be removed from server")
	}
}

func TestKickMemberUnauthenticated(t *testing.T) {
	client, serverID, _, _, targetID, _, _, _ := setupModerationScenario(t)

	// Send request without auth token.
	_, err := client.KickMember(context.Background(), connect.NewRequest(&v1.KickMemberRequest{
		ServerId: serverID,
		UserId:   targetID,
	}))
	if err == nil {
		t.Fatal("expected error for unauthenticated request")
	}
	if connect.CodeOf(err) != connect.CodeUnauthenticated {
		t.Errorf("code = %v, want Unauthenticated", connect.CodeOf(err))
	}
}

func TestKickMemberNoPermission(t *testing.T) {
	client, serverID, _, _, targetID, chatStore, _, _ := setupModerationScenario(t)

	// Add a member with no roles (no KickMembers permission).
	noPermUserID := models.NewID()
	chatStore.AddMember(context.Background(), noPermUserID, serverID)

	_, err := client.KickMember(context.Background(), testutil.AuthedRequest(t, noPermUserID, &v1.KickMemberRequest{
		ServerId: serverID,
		UserId:   targetID,
	}))
	if err == nil {
		t.Fatal("expected error for missing permission")
	}
	if connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Errorf("code = %v, want PermissionDenied", connect.CodeOf(err))
	}
}

func TestKickMemberHierarchyViolation(t *testing.T) {
	client, serverID, _, _, targetID, chatStore, roleStore, _ := setupModerationScenario(t)

	// Create a lower-ranked moderator (position 1) who has KickMembers but is below target (position 5).
	modID := models.NewID()
	chatStore.AddMember(context.Background(), modID, serverID)
	modRoleID := models.NewID()
	roleStore.CreateRole(context.Background(), &models.Role{
		ID:          modRoleID,
		ServerID:    serverID,
		Name:        "LowMod",
		Position:    1,
		Permissions: permissions.KickMembers,
	})
	roleStore.assignRoles(serverID, modID, []string{modRoleID})

	_, err := client.KickMember(context.Background(), testutil.AuthedRequest(t, modID, &v1.KickMemberRequest{
		ServerId: serverID,
		UserId:   targetID,
	}))
	if err == nil {
		t.Fatal("expected error for hierarchy violation")
	}
	if connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Errorf("code = %v, want PermissionDenied", connect.CodeOf(err))
	}
}

func TestKickMemberOwnerProtection(t *testing.T) {
	client, serverID, ownerID, adminID, _, _, _, _ := setupModerationScenario(t)

	_, err := client.KickMember(context.Background(), testutil.AuthedRequest(t, adminID, &v1.KickMemberRequest{
		ServerId: serverID,
		UserId:   ownerID,
	}))
	if err == nil {
		t.Fatal("expected error for kicking server owner")
	}
	if connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Errorf("code = %v, want PermissionDenied", connect.CodeOf(err))
	}
}

func TestKickMemberSelf(t *testing.T) {
	client, serverID, _, adminID, _, _, _, _ := setupModerationScenario(t)

	_, err := client.KickMember(context.Background(), testutil.AuthedRequest(t, adminID, &v1.KickMemberRequest{
		ServerId: serverID,
		UserId:   adminID,
	}))
	if err == nil {
		t.Fatal("expected error for self-kick")
	}
	if connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Errorf("code = %v, want InvalidArgument", connect.CodeOf(err))
	}
}

func TestKickMemberTargetNotMember(t *testing.T) {
	client, serverID, _, adminID, _, _, _, _ := setupModerationScenario(t)

	nonMemberID := models.NewID()
	_, err := client.KickMember(context.Background(), testutil.AuthedRequest(t, adminID, &v1.KickMemberRequest{
		ServerId: serverID,
		UserId:   nonMemberID,
	}))
	if err == nil {
		t.Fatal("expected error for non-member target")
	}
	if connect.CodeOf(err) != connect.CodeNotFound {
		t.Errorf("code = %v, want NotFound", connect.CodeOf(err))
	}
}

func TestKickMemberCallerNotMember(t *testing.T) {
	client, serverID, _, _, targetID, _, _, _ := setupModerationScenario(t)

	outsiderID := models.NewID()
	_, err := client.KickMember(context.Background(), testutil.AuthedRequest(t, outsiderID, &v1.KickMemberRequest{
		ServerId: serverID,
		UserId:   targetID,
	}))
	if err == nil {
		t.Fatal("expected error for non-member caller")
	}
	if connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Errorf("code = %v, want PermissionDenied", connect.CodeOf(err))
	}
}

// --- BanMember tests ---

func TestBanMemberSuccess(t *testing.T) {
	client, serverID, _, adminID, targetID, _, _, banStore := setupModerationScenario(t)

	_, err := client.BanMember(context.Background(), testutil.AuthedRequest(t, adminID, &v1.BanMemberRequest{
		ServerId: serverID,
		UserId:   targetID,
	}))
	if err != nil {
		t.Fatalf("BanMember: %v", err)
	}

	// Verify ban was created. (Member removal is atomic in the real store's
	// CreateBanAndRemoveMember; the mock only tracks the ban.)
	isBanned, _ := banStore.IsBanned(context.Background(), serverID, targetID)
	if !isBanned {
		t.Error("expected target to be banned")
	}
}

func TestBanMemberUnauthenticated(t *testing.T) {
	client, serverID, _, _, targetID, _, _, _ := setupModerationScenario(t)

	_, err := client.BanMember(context.Background(), connect.NewRequest(&v1.BanMemberRequest{
		ServerId: serverID,
		UserId:   targetID,
	}))
	if err == nil {
		t.Fatal("expected error for unauthenticated request")
	}
	if connect.CodeOf(err) != connect.CodeUnauthenticated {
		t.Errorf("code = %v, want Unauthenticated", connect.CodeOf(err))
	}
}

func TestBanMemberNoPermission(t *testing.T) {
	client, serverID, _, _, targetID, chatStore, _, _ := setupModerationScenario(t)

	noPermUserID := models.NewID()
	chatStore.AddMember(context.Background(), noPermUserID, serverID)

	_, err := client.BanMember(context.Background(), testutil.AuthedRequest(t, noPermUserID, &v1.BanMemberRequest{
		ServerId: serverID,
		UserId:   targetID,
	}))
	if err == nil {
		t.Fatal("expected error for missing permission")
	}
	if connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Errorf("code = %v, want PermissionDenied", connect.CodeOf(err))
	}
}

func TestBanMemberHierarchyViolation(t *testing.T) {
	client, serverID, _, _, targetID, chatStore, roleStore, _ := setupModerationScenario(t)

	// Create lower-ranked mod below target.
	modID := models.NewID()
	chatStore.AddMember(context.Background(), modID, serverID)
	modRoleID := models.NewID()
	roleStore.CreateRole(context.Background(), &models.Role{
		ID:          modRoleID,
		ServerID:    serverID,
		Name:        "LowMod",
		Position:    1,
		Permissions: permissions.BanMembers,
	})
	roleStore.assignRoles(serverID, modID, []string{modRoleID})

	_, err := client.BanMember(context.Background(), testutil.AuthedRequest(t, modID, &v1.BanMemberRequest{
		ServerId: serverID,
		UserId:   targetID,
	}))
	if err == nil {
		t.Fatal("expected error for hierarchy violation")
	}
	if connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Errorf("code = %v, want PermissionDenied", connect.CodeOf(err))
	}
}

func TestBanMemberOwnerProtection(t *testing.T) {
	client, serverID, ownerID, adminID, _, _, _, _ := setupModerationScenario(t)

	_, err := client.BanMember(context.Background(), testutil.AuthedRequest(t, adminID, &v1.BanMemberRequest{
		ServerId: serverID,
		UserId:   ownerID,
	}))
	if err == nil {
		t.Fatal("expected error for banning server owner")
	}
	if connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Errorf("code = %v, want PermissionDenied", connect.CodeOf(err))
	}
}

func TestBanMemberSelf(t *testing.T) {
	client, serverID, _, adminID, _, _, _, _ := setupModerationScenario(t)

	_, err := client.BanMember(context.Background(), testutil.AuthedRequest(t, adminID, &v1.BanMemberRequest{
		ServerId: serverID,
		UserId:   adminID,
	}))
	if err == nil {
		t.Fatal("expected error for self-ban")
	}
	if connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Errorf("code = %v, want InvalidArgument", connect.CodeOf(err))
	}
}

func TestBanMemberAlreadyBanned(t *testing.T) {
	client, serverID, _, adminID, targetID, _, _, _ := setupModerationScenario(t)

	// First ban.
	_, err := client.BanMember(context.Background(), testutil.AuthedRequest(t, adminID, &v1.BanMemberRequest{
		ServerId: serverID,
		UserId:   targetID,
	}))
	if err != nil {
		t.Fatalf("first BanMember: %v", err)
	}

	// Second ban should fail.
	_, err = client.BanMember(context.Background(), testutil.AuthedRequest(t, adminID, &v1.BanMemberRequest{
		ServerId: serverID,
		UserId:   targetID,
	}))
	if err == nil {
		t.Fatal("expected error for already banned")
	}
	if connect.CodeOf(err) != connect.CodeAlreadyExists {
		t.Errorf("code = %v, want AlreadyExists", connect.CodeOf(err))
	}
}

func TestBanMemberPreemptive(t *testing.T) {
	client, serverID, _, adminID, _, _, _, banStore := setupModerationScenario(t)

	// Ban a non-member (pre-emptive ban).
	nonMemberID := models.NewID()
	_, err := client.BanMember(context.Background(), testutil.AuthedRequest(t, adminID, &v1.BanMemberRequest{
		ServerId: serverID,
		UserId:   nonMemberID,
	}))
	if err != nil {
		t.Fatalf("BanMember (pre-emptive): %v", err)
	}

	isBanned, _ := banStore.IsBanned(context.Background(), serverID, nonMemberID)
	if !isBanned {
		t.Error("expected pre-emptive ban to be created")
	}
}

func TestBanMemberWithReason(t *testing.T) {
	client, serverID, _, adminID, targetID, _, _, banStore := setupModerationScenario(t)

	reason := "spamming"
	_, err := client.BanMember(context.Background(), testutil.AuthedRequest(t, adminID, &v1.BanMemberRequest{
		ServerId: serverID,
		UserId:   targetID,
		Reason:   &reason,
	}))
	if err != nil {
		t.Fatalf("BanMember: %v", err)
	}

	// Verify reason stored.
	banStore.mu.Lock()
	ban := banStore.bans[serverID][targetID]
	banStore.mu.Unlock()
	if ban.Reason != "spamming" {
		t.Errorf("reason = %q, want %q", ban.Reason, "spamming")
	}
}

// --- UnbanMember tests ---

func TestUnbanMemberSuccess(t *testing.T) {
	client, serverID, _, adminID, targetID, _, _, banStore := setupModerationScenario(t)

	// Ban first.
	client.BanMember(context.Background(), testutil.AuthedRequest(t, adminID, &v1.BanMemberRequest{
		ServerId: serverID,
		UserId:   targetID,
	}))

	// Unban.
	_, err := client.UnbanMember(context.Background(), testutil.AuthedRequest(t, adminID, &v1.UnbanMemberRequest{
		ServerId: serverID,
		UserId:   targetID,
	}))
	if err != nil {
		t.Fatalf("UnbanMember: %v", err)
	}

	isBanned, _ := banStore.IsBanned(context.Background(), serverID, targetID)
	if isBanned {
		t.Error("expected ban to be removed")
	}
}

func TestUnbanMemberNoPermission(t *testing.T) {
	client, serverID, _, adminID, targetID, chatStore, _, _ := setupModerationScenario(t)

	// Ban first.
	client.BanMember(context.Background(), testutil.AuthedRequest(t, adminID, &v1.BanMemberRequest{
		ServerId: serverID,
		UserId:   targetID,
	}))

	noPermUserID := models.NewID()
	chatStore.AddMember(context.Background(), noPermUserID, serverID)

	_, err := client.UnbanMember(context.Background(), testutil.AuthedRequest(t, noPermUserID, &v1.UnbanMemberRequest{
		ServerId: serverID,
		UserId:   targetID,
	}))
	if err == nil {
		t.Fatal("expected error for missing permission")
	}
	if connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Errorf("code = %v, want PermissionDenied", connect.CodeOf(err))
	}
}

func TestUnbanMemberNotBanned(t *testing.T) {
	client, serverID, _, adminID, _, _, _, _ := setupModerationScenario(t)

	nonBannedID := models.NewID()
	_, err := client.UnbanMember(context.Background(), testutil.AuthedRequest(t, adminID, &v1.UnbanMemberRequest{
		ServerId: serverID,
		UserId:   nonBannedID,
	}))
	if err == nil {
		t.Fatal("expected error for non-banned user")
	}
	if connect.CodeOf(err) != connect.CodeNotFound {
		t.Errorf("code = %v, want NotFound", connect.CodeOf(err))
	}
}

func TestUnbanMemberUnauthenticated(t *testing.T) {
	client, serverID, _, _, targetID, _, _, _ := setupModerationScenario(t)

	_, err := client.UnbanMember(context.Background(), connect.NewRequest(&v1.UnbanMemberRequest{
		ServerId: serverID,
		UserId:   targetID,
	}))
	if err == nil {
		t.Fatal("expected error for unauthenticated request")
	}
	if connect.CodeOf(err) != connect.CodeUnauthenticated {
		t.Errorf("code = %v, want Unauthenticated", connect.CodeOf(err))
	}
}

// --- ListBans tests ---

func TestListBansSuccess(t *testing.T) {
	client, serverID, _, adminID, targetID, _, _, _ := setupModerationScenario(t)

	// Ban a member.
	client.BanMember(context.Background(), testutil.AuthedRequest(t, adminID, &v1.BanMemberRequest{
		ServerId: serverID,
		UserId:   targetID,
	}))

	resp, err := client.ListBans(context.Background(), testutil.AuthedRequest(t, adminID, &v1.ListBansRequest{
		ServerId: serverID,
	}))
	if err != nil {
		t.Fatalf("ListBans: %v", err)
	}
	if len(resp.Msg.Bans) != 1 {
		t.Fatalf("bans count = %d, want 1", len(resp.Msg.Bans))
	}
	if resp.Msg.Bans[0].UserId != targetID {
		t.Errorf("banned user = %q, want %q", resp.Msg.Bans[0].UserId, targetID)
	}
}

func TestListBansNoPermission(t *testing.T) {
	client, serverID, _, _, _, chatStore, _, _ := setupModerationScenario(t)

	noPermUserID := models.NewID()
	chatStore.AddMember(context.Background(), noPermUserID, serverID)

	_, err := client.ListBans(context.Background(), testutil.AuthedRequest(t, noPermUserID, &v1.ListBansRequest{
		ServerId: serverID,
	}))
	if err == nil {
		t.Fatal("expected error for missing permission")
	}
	if connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Errorf("code = %v, want PermissionDenied", connect.CodeOf(err))
	}
}

func TestListBansNotMember(t *testing.T) {
	client, serverID, _, _, _, _, _, _ := setupModerationScenario(t)

	outsiderID := models.NewID()
	_, err := client.ListBans(context.Background(), testutil.AuthedRequest(t, outsiderID, &v1.ListBansRequest{
		ServerId: serverID,
	}))
	if err == nil {
		t.Fatal("expected error for non-member")
	}
	if connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Errorf("code = %v, want PermissionDenied", connect.CodeOf(err))
	}
}

// --- Role CRUD tests ---

func TestCreateRoleSuccess(t *testing.T) {
	client, serverID, ownerID, _, _, _, _, _ := setupModerationScenario(t)

	resp, err := client.CreateRole(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.CreateRoleRequest{
		ServerId:    serverID,
		Name:        "Tester",
		Permissions: permissions.KickMembers,
		Color:       0xFF0000,
	}))
	if err != nil {
		t.Fatalf("CreateRole: %v", err)
	}
	if resp.Msg.Role == nil {
		t.Fatal("expected role in response")
	}
	if resp.Msg.Role.Name != "Tester" {
		t.Errorf("name = %q, want %q", resp.Msg.Role.Name, "Tester")
	}
	if resp.Msg.Role.Permissions != permissions.KickMembers {
		t.Errorf("permissions = %d, want %d", resp.Msg.Role.Permissions, permissions.KickMembers)
	}
}

func TestCreateRoleUnauthenticated(t *testing.T) {
	client, serverID, _, _, _, _, _, _ := setupModerationScenario(t)

	_, err := client.CreateRole(context.Background(), connect.NewRequest(&v1.CreateRoleRequest{
		ServerId: serverID,
		Name:     "Tester",
	}))
	if err == nil {
		t.Fatal("expected error for unauthenticated")
	}
	if connect.CodeOf(err) != connect.CodeUnauthenticated {
		t.Errorf("code = %v, want Unauthenticated", connect.CodeOf(err))
	}
}

func TestCreateRoleNoPermission(t *testing.T) {
	client, serverID, _, _, _, chatStore, _, _ := setupModerationScenario(t)

	noPermUserID := models.NewID()
	chatStore.AddMember(context.Background(), noPermUserID, serverID)

	_, err := client.CreateRole(context.Background(), testutil.AuthedRequest(t, noPermUserID, &v1.CreateRoleRequest{
		ServerId: serverID,
		Name:     "Hacker",
	}))
	if err == nil {
		t.Fatal("expected error for missing ManageRoles")
	}
	if connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Errorf("code = %v, want PermissionDenied", connect.CodeOf(err))
	}
}

func TestCreateRoleMissingName(t *testing.T) {
	client, serverID, ownerID, _, _, _, _, _ := setupModerationScenario(t)

	_, err := client.CreateRole(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.CreateRoleRequest{
		ServerId: serverID,
	}))
	if err == nil {
		t.Fatal("expected error for missing name")
	}
	if connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Errorf("code = %v, want InvalidArgument", connect.CodeOf(err))
	}
}

func TestCreateRoleNotMember(t *testing.T) {
	client, serverID, _, _, _, _, _, _ := setupModerationScenario(t)

	outsiderID := models.NewID()
	_, err := client.CreateRole(context.Background(), testutil.AuthedRequest(t, outsiderID, &v1.CreateRoleRequest{
		ServerId: serverID,
		Name:     "Hacker",
	}))
	if err == nil {
		t.Fatal("expected error for non-member")
	}
	if connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Errorf("code = %v, want PermissionDenied", connect.CodeOf(err))
	}
}

func TestCreateRoleEscalation(t *testing.T) {
	client, serverID, _, adminID, _, _, _, _ := setupModerationScenario(t)

	// Admin has ManageRoles+KickMembers+BanMembers (position 10).
	// Attempt to create a role with Administrator permission — should be denied.
	_, err := client.CreateRole(context.Background(), testutil.AuthedRequest(t, adminID, &v1.CreateRoleRequest{
		ServerId:    serverID,
		Name:        "Escalated",
		Permissions: permissions.Administrator,
	}))
	if err == nil {
		t.Fatal("expected error for permission escalation")
	}
	if connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Errorf("code = %v, want PermissionDenied", connect.CodeOf(err))
	}
}

func TestCreateRoleEscalationAllowed(t *testing.T) {
	client, serverID, ownerID, _, _, _, _, _ := setupModerationScenario(t)

	// Owner can create a role with any permissions, including Administrator.
	resp, err := client.CreateRole(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.CreateRoleRequest{
		ServerId:    serverID,
		Name:        "SuperRole",
		Permissions: permissions.Administrator,
	}))
	if err != nil {
		t.Fatalf("CreateRole (owner): %v", err)
	}
	if resp.Msg.Role.Permissions != permissions.Administrator {
		t.Errorf("permissions = %d, want %d", resp.Msg.Role.Permissions, permissions.Administrator)
	}
}

// --- UpdateRole tests ---

func TestUpdateRoleSuccess(t *testing.T) {
	client, serverID, ownerID, _, _, _, roleStore, _ := setupModerationScenario(t)

	// Create a role to update.
	roleID := models.NewID()
	roleStore.CreateRole(context.Background(), &models.Role{
		ID:       roleID,
		ServerID: serverID,
		Name:     "OldName",
		Position: 1,
	})

	newName := "NewName"
	resp, err := client.UpdateRole(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.UpdateRoleRequest{
		RoleId: roleID,
		Name:   &newName,
	}))
	if err != nil {
		t.Fatalf("UpdateRole: %v", err)
	}
	if resp.Msg.Role.Name != "NewName" {
		t.Errorf("name = %q, want %q", resp.Msg.Role.Name, "NewName")
	}
}

func TestUpdateRoleNoPermission(t *testing.T) {
	client, serverID, _, _, _, chatStore, roleStore, _ := setupModerationScenario(t)

	roleID := models.NewID()
	roleStore.CreateRole(context.Background(), &models.Role{
		ID:       roleID,
		ServerID: serverID,
		Name:     "Target",
		Position: 1,
	})

	noPermUserID := models.NewID()
	chatStore.AddMember(context.Background(), noPermUserID, serverID)

	newName := "Hacked"
	_, err := client.UpdateRole(context.Background(), testutil.AuthedRequest(t, noPermUserID, &v1.UpdateRoleRequest{
		RoleId: roleID,
		Name:   &newName,
	}))
	if err == nil {
		t.Fatal("expected error for missing ManageRoles")
	}
	if connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Errorf("code = %v, want PermissionDenied", connect.CodeOf(err))
	}
}

func TestUpdateRoleEscalation(t *testing.T) {
	client, serverID, _, adminID, _, _, roleStore, _ := setupModerationScenario(t)

	// Create a low role. Admin has ManageRoles+KickMembers+BanMembers.
	roleID := models.NewID()
	roleStore.CreateRole(context.Background(), &models.Role{
		ID:       roleID,
		ServerID: serverID,
		Name:     "LowRole",
		Position: 1,
	})

	// Try to set Administrator permission (which admin doesn't have).
	adminPerms := permissions.Administrator
	_, err := client.UpdateRole(context.Background(), testutil.AuthedRequest(t, adminID, &v1.UpdateRoleRequest{
		RoleId:      roleID,
		Permissions: &adminPerms,
	}))
	if err == nil {
		t.Fatal("expected error for permission escalation")
	}
	if connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Errorf("code = %v, want PermissionDenied", connect.CodeOf(err))
	}
}

func TestUpdateRoleOwnerBypasses(t *testing.T) {
	client, serverID, ownerID, _, _, _, roleStore, _ := setupModerationScenario(t)

	roleID := models.NewID()
	roleStore.CreateRole(context.Background(), &models.Role{
		ID:       roleID,
		ServerID: serverID,
		Name:     "AnyRole",
		Position: 1,
	})

	// Owner can set any permission.
	adminPerms := permissions.Administrator
	resp, err := client.UpdateRole(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.UpdateRoleRequest{
		RoleId:      roleID,
		Permissions: &adminPerms,
	}))
	if err != nil {
		t.Fatalf("UpdateRole (owner): %v", err)
	}
	if resp.Msg.Role.Permissions != permissions.Administrator {
		t.Errorf("permissions = %d, want %d", resp.Msg.Role.Permissions, permissions.Administrator)
	}
}

func TestUpdateRoleNotFound(t *testing.T) {
	client, _, ownerID, _, _, _, _, _ := setupModerationScenario(t)

	newName := "Ghost"
	_, err := client.UpdateRole(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.UpdateRoleRequest{
		RoleId: "nonexistent-role-id",
		Name:   &newName,
	}))
	if err == nil {
		t.Fatal("expected error for nonexistent role")
	}
	if connect.CodeOf(err) != connect.CodeNotFound {
		t.Errorf("code = %v, want NotFound", connect.CodeOf(err))
	}
}

func TestUpdateRoleHierarchyViolation(t *testing.T) {
	client, serverID, _, adminID, _, _, roleStore, _ := setupModerationScenario(t)

	// Create a role at position 15 (above admin's position 10).
	highRoleID := models.NewID()
	roleStore.CreateRole(context.Background(), &models.Role{
		ID:       highRoleID,
		ServerID: serverID,
		Name:     "HighRole",
		Position: 15,
	})

	newName := "Hacked"
	_, err := client.UpdateRole(context.Background(), testutil.AuthedRequest(t, adminID, &v1.UpdateRoleRequest{
		RoleId: highRoleID,
		Name:   &newName,
	}))
	if err == nil {
		t.Fatal("expected error for modifying higher role")
	}
	if connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Errorf("code = %v, want PermissionDenied", connect.CodeOf(err))
	}
}

// --- DeleteRole tests ---

func TestDeleteRoleSuccess(t *testing.T) {
	client, serverID, ownerID, _, _, _, roleStore, _ := setupModerationScenario(t)

	roleID := models.NewID()
	roleStore.CreateRole(context.Background(), &models.Role{
		ID:       roleID,
		ServerID: serverID,
		Name:     "Doomed",
		Position: 1,
	})

	_, err := client.DeleteRole(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.DeleteRoleRequest{
		RoleId: roleID,
	}))
	if err != nil {
		t.Fatalf("DeleteRole: %v", err)
	}

	// Verify role is gone.
	_, err = roleStore.GetRole(context.Background(), roleID)
	if err == nil {
		t.Error("expected role to be deleted")
	}
}

func TestDeleteRoleNoPermission(t *testing.T) {
	client, serverID, _, _, _, chatStore, roleStore, _ := setupModerationScenario(t)

	roleID := models.NewID()
	roleStore.CreateRole(context.Background(), &models.Role{
		ID:       roleID,
		ServerID: serverID,
		Name:     "Protected",
		Position: 1,
	})

	noPermUserID := models.NewID()
	chatStore.AddMember(context.Background(), noPermUserID, serverID)

	_, err := client.DeleteRole(context.Background(), testutil.AuthedRequest(t, noPermUserID, &v1.DeleteRoleRequest{
		RoleId: roleID,
	}))
	if err == nil {
		t.Fatal("expected error for missing ManageRoles")
	}
	if connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Errorf("code = %v, want PermissionDenied", connect.CodeOf(err))
	}
}

func TestDeleteRoleHierarchy(t *testing.T) {
	client, serverID, _, adminID, _, _, roleStore, _ := setupModerationScenario(t)

	// Create a role above admin's position.
	highRoleID := models.NewID()
	roleStore.CreateRole(context.Background(), &models.Role{
		ID:       highRoleID,
		ServerID: serverID,
		Name:     "HighRole",
		Position: 15,
	})

	_, err := client.DeleteRole(context.Background(), testutil.AuthedRequest(t, adminID, &v1.DeleteRoleRequest{
		RoleId: highRoleID,
	}))
	if err == nil {
		t.Fatal("expected error for deleting higher role")
	}
	if connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Errorf("code = %v, want PermissionDenied", connect.CodeOf(err))
	}
}

func TestDeleteRoleNotFound(t *testing.T) {
	client, _, ownerID, _, _, _, _, _ := setupModerationScenario(t)

	_, err := client.DeleteRole(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.DeleteRoleRequest{
		RoleId: "nonexistent-role-id",
	}))
	if err == nil {
		t.Fatal("expected error for nonexistent role")
	}
	if connect.CodeOf(err) != connect.CodeNotFound {
		t.Errorf("code = %v, want NotFound", connect.CodeOf(err))
	}
}

// --- ListRoles tests ---

func TestListRolesSuccess(t *testing.T) {
	client, serverID, ownerID, _, _, _, _, _ := setupModerationScenario(t)

	resp, err := client.ListRoles(context.Background(), testutil.AuthedRequest(t, ownerID, &v1.ListRolesRequest{
		ServerId: serverID,
	}))
	if err != nil {
		t.Fatalf("ListRoles: %v", err)
	}
	// Setup creates 3 roles (@everyone + Admin + Moderator).
	if len(resp.Msg.Roles) != 3 {
		t.Errorf("roles count = %d, want 3", len(resp.Msg.Roles))
	}
}

func TestListRolesNotMember(t *testing.T) {
	client, serverID, _, _, _, _, _, _ := setupModerationScenario(t)

	outsiderID := models.NewID()
	_, err := client.ListRoles(context.Background(), testutil.AuthedRequest(t, outsiderID, &v1.ListRolesRequest{
		ServerId: serverID,
	}))
	if err == nil {
		t.Fatal("expected error for non-member")
	}
	if connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Errorf("code = %v, want PermissionDenied", connect.CodeOf(err))
	}
}

