//go:build integration

package security

import (
	"context"
	"strings"
	"testing"

	"connectrpc.com/connect"
	v1 "github.com/mezalabs/meza/gen/meza/v1"
	"github.com/mezalabs/meza/internal/auth"
)

// TestRevokedDeviceTokenStillValid verifies that a JWT issued before device
// revocation continues to be accepted by services.
//
// Severity: CRITICAL
// Finding: Revoked device tokens remain valid for up to 1 hour (access token expiry).
// The RevokeDevice RPC deletes the device record from the database, but no
// token blocklist is checked in the ConnectRPC interceptor.
//
// Remediation: Add a Redis-backed token blocklist (SET with TTL matching token
// expiry) checked in the ConnectRPC interceptor on every authenticated request.
func TestRevokedDeviceTokenStillValid(t *testing.T) {
	suffix := uniqueSuffix(t)
	user := registerUser(t, suffix)
	ctx := context.Background()

	// 1. Verify the token works before revocation.
	authClient := newAuthClient()
	_, err := authClient.GetProfile(ctx, authedRequest(user.AccessToken, &v1.GetProfileRequest{
		UserId: user.UserID,
	}))
	if err != nil {
		t.Fatalf("GetProfile before revocation should succeed: %v", err)
	}

	// 2. List devices to find the device ID.
	devicesResp, err := authClient.ListDevices(ctx, authedRequest(user.AccessToken, &v1.ListDevicesRequest{}))
	if err != nil {
		t.Fatalf("ListDevices: %v", err)
	}
	if len(devicesResp.Msg.Devices) == 0 {
		t.Fatal("expected at least one device")
	}
	deviceID := devicesResp.Msg.Devices[0].Id

	// 3. Revoke the device.
	_, err = authClient.RevokeDevice(ctx, authedRequest(user.AccessToken, &v1.RevokeDeviceRequest{
		DeviceId: deviceID,
	}))
	if err != nil {
		t.Fatalf("RevokeDevice: %v", err)
	}

	// 4. Verify the SAME token is still accepted (vulnerability).
	_, err = authClient.GetProfile(ctx, authedRequest(user.AccessToken, &v1.GetProfileRequest{
		UserId: user.UserID,
	}))
	if err == nil {
		t.Error("VULNERABILITY CONFIRMED: Revoked device token still accepted by auth service")
	} else {
		t.Log("Mitigated: Revoked device token correctly rejected by auth service")
	}

	// 5. Also verify against chat service.
	chatClient := newChatClient()
	_, chatErr := chatClient.GetServer(ctx, authedRequest(user.AccessToken, &v1.GetServerRequest{
		ServerId: "nonexistent",
	}))
	// We expect CodeNotFound for a nonexistent server, NOT CodeUnauthenticated.
	// If we get CodeNotFound, the token was accepted (vulnerability).
	if chatErr != nil && connect.CodeOf(chatErr) == connect.CodeUnauthenticated {
		t.Log("Mitigated: Revoked device token correctly rejected by chat service")
	} else {
		t.Error("VULNERABILITY CONFIRMED: Revoked device token still accepted by chat service")
	}
}

// TestAccountRecoveryFailsOpenWithoutRedis is a regression test confirming that
// the recovery rate limiter fails closed (returns CodeUnavailable) when Redis
// is unavailable.
//
// Severity: LOW (regression test)
// Finding: REMEDIATED — checkRecoveryRateLimit now returns CodeUnavailable when
// s.redisClient is nil, and also returns CodeUnavailable on Redis errors (fail
// closed). See server/cmd/auth/service.go:44-47.
//
// This test is SKIPPED because it requires stopping the Redis container mid-test.
// Manual test steps are documented below to confirm the fix remains in place.
//
// Original issue: checkRecoveryRateLimit previously returned nil (fail open)
// when Redis was nil or when Redis operations failed, allowing brute-force
// recovery attempts with no throttling.
func TestAccountRecoveryFailsOpenWithoutRedis(t *testing.T) {
	t.Skip(`REGRESSION TEST — MANUAL VERIFICATION:
1. Start the local stack: task start
2. Call RecoverAccount 5 times for the same email (should succeed, then get rate-limited)
3. Stop Redis: docker stop meza-redis
4. Call RecoverAccount again — should return CodeUnavailable (confirming fail-closed fix)
5. Restart Redis: docker start meza-redis

The fix is in server/cmd/auth/service.go:44-47:
  if s.redisClient == nil {
      return connect.NewError(connect.CodeUnavailable, errors.New("recovery temporarily unavailable"))
  }`)
}

// TestArgon2idParametersBelowOWASP is a regression test confirming the Argon2id
// time parameter meets OWASP recommendations.
//
// Severity: REGRESSION
// Finding: REMEDIATED — argonTime is now 3 (server/internal/auth/argon2.go:14),
// meeting the OWASP-recommended minimum. This test ensures the parameter does
// not regress below the required threshold.
//
// Original issue: The Argon2id configuration previously used time=2, which was
// below the OWASP-recommended minimum of time=3.
func TestArgon2idParametersBelowOWASP(t *testing.T) {
	// Hash a test password and inspect the parameters encoded in the hash.
	hash, err := auth.HashPassword("test-password-for-parameter-check")
	if err != nil {
		t.Fatalf("HashPassword: %v", err)
	}

	// Argon2id hash format: $argon2id$v=19$m=65536,t=2,p=4$<salt>$<hash>
	// Check that the time parameter (t) is at least 3.
	if !strings.Contains(hash, ",t=3,") && !strings.Contains(hash, ",t=4,") && !strings.Contains(hash, ",t=5,") {
		t.Errorf("FINDING: Argon2id time parameter below OWASP minimum (expected t>=3): %s", hash)
	} else {
		t.Log("Argon2id time parameter meets OWASP minimum")
	}
}
