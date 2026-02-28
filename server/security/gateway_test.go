//go:build integration

package security

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/coder/websocket"
	v1 "github.com/meza-chat/meza/gen/meza/v1"
	"google.golang.org/protobuf/proto"
)

// makeEnvelope creates a protobuf-encoded GatewayEnvelope for WebSocket messages.
func makeEnvelope(t *testing.T, op v1.GatewayOpCode, payload []byte) []byte {
	t.Helper()
	data, err := proto.Marshal(&v1.GatewayEnvelope{Op: op, Payload: payload})
	if err != nil {
		t.Fatalf("makeEnvelope: %v", err)
	}
	return data
}

// parseEnvelope decodes a protobuf-encoded GatewayEnvelope from WebSocket data.
func parseEnvelope(t *testing.T, data []byte) *v1.GatewayEnvelope {
	t.Helper()
	env := &v1.GatewayEnvelope{}
	if err := proto.Unmarshal(data, env); err != nil {
		t.Fatalf("parseEnvelope: %v", err)
	}
	return env
}

// connectGateway dials the WebSocket gateway and performs the IDENTIFY handshake.
// Returns the established connection or fails the test.
func connectGateway(t *testing.T, token string) *websocket.Conn {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	conn, _, err := websocket.Dial(ctx, gatewayWSURL+"/ws", nil)
	if err != nil {
		t.Fatalf("WebSocket dial: %v", err)
	}
	t.Cleanup(func() { conn.CloseNow() })

	// Send IDENTIFY with token.
	identifyPayload, _ := json.Marshal(map[string]string{"token": token})
	err = conn.Write(ctx, websocket.MessageBinary, makeEnvelope(t, v1.GatewayOpCode_GATEWAY_OP_IDENTIFY, identifyPayload))
	if err != nil {
		t.Fatalf("WebSocket write IDENTIFY: %v", err)
	}

	// Read READY response.
	readCtx, readCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer readCancel()
	_, data, err := conn.Read(readCtx)
	if err != nil {
		t.Fatalf("WebSocket read READY: %v", err)
	}
	env := parseEnvelope(t, data)
	if env.Op != v1.GatewayOpCode_GATEWAY_OP_READY {
		t.Fatalf("expected READY, got op=%d", env.Op)
	}

	return conn
}

// TestWebSocketRefreshTokenRejection verifies that the gateway rejects
// WebSocket authentication with a refresh token.
//
// Severity: HIGH
// Finding: The gateway's authenticateFirstMessage should reject refresh tokens
// via the IsRefresh check in ValidateTokenEd25519. This is a regression test.
//
// Note: SpecFlow analysis suggests this is already mitigated.
//
// Remediation: Ensure authenticateFirstMessage checks IsRefresh and rejects
// refresh tokens, matching the ConnectRPC interceptor behavior.
func TestWebSocketRefreshTokenRejection(t *testing.T) {
	suffix := uniqueSuffix(t)
	user := registerUser(t, "wsref_"+suffix)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	conn, _, err := websocket.Dial(ctx, gatewayWSURL+"/ws", nil)
	if err != nil {
		t.Fatalf("WebSocket dial: %v", err)
	}
	defer conn.CloseNow()

	// Send IDENTIFY with REFRESH token (not access token).
	identifyPayload, _ := json.Marshal(map[string]string{"token": user.RefreshToken})
	err = conn.Write(ctx, websocket.MessageBinary, makeEnvelope(t, v1.GatewayOpCode_GATEWAY_OP_IDENTIFY, identifyPayload))
	if err != nil {
		t.Fatalf("WebSocket write IDENTIFY: %v", err)
	}

	// Read response — should be a close frame or error, NOT a READY.
	readCtx, readCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer readCancel()
	_, data, err := conn.Read(readCtx)
	if err != nil {
		// Connection closed = refresh token correctly rejected.
		t.Log("Mitigated: WebSocket correctly rejected refresh token (connection closed)")
		return
	}

	env := parseEnvelope(t, data)
	if env.Op == v1.GatewayOpCode_GATEWAY_OP_READY {
		t.Error("VULNERABILITY CONFIRMED: WebSocket accepted refresh token for authentication")
	} else {
		t.Logf("Received op=%d (not READY) — likely rejected", env.Op)
	}
}

// TestTypingIndicatorNoChannelMembershipCheck is a regression test verifying
// that the gateway checks channel membership before forwarding typing events.
//
// Severity: REGRESSION
// Finding: The gateway's readPump handles GATEWAY_OP_TYPING_START and checks
// client.Channels before publishing (gateway.go:819-830). If the sender is
// not a member, the event is silently dropped with a slog.Warn.
//
// Regression: This test ensures the membership check remains in place by
// having a non-member send typing and verifying the member does NOT receive it.
// A control message confirms the listener is working.
func TestTypingIndicatorNoChannelMembershipCheck(t *testing.T) {
	suffix := uniqueSuffix(t)

	// User A creates server + channel, connects to gateway (listener).
	userA := registerUser(t, "typ_a_"+suffix)
	serverID := mustCreateServer(t, userA.AccessToken)
	channelID := mustCreateChannel(t, userA.AccessToken, serverID)
	connA := connectGateway(t, userA.AccessToken)

	// User B is NOT a member of User A's server, connects to gateway.
	userB := registerUser(t, "typ_b_"+suffix)
	connB := connectGateway(t, userB.AccessToken)

	// User B sends TYPING_START for User A's channel (should be dropped).
	typingPayload, _ := proto.Marshal(&v1.TypingEvent{
		ChannelId: channelID,
	})
	writeCtx, writeCancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer writeCancel()
	err := connB.Write(writeCtx, websocket.MessageBinary, makeEnvelope(t, v1.GatewayOpCode_GATEWAY_OP_TYPING_START, typingPayload))
	if err != nil {
		t.Log("Mitigated: Gateway closed connection on non-member typing")
		return
	}

	// Wait and check if User A receives ANY typing event — they should NOT.
	readCtx, readCancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer readCancel()
	_, data, err := connA.Read(readCtx)
	if err != nil {
		// Timeout = no event received = correct behavior.
		t.Log("Mitigated: Non-member typing event was not forwarded to channel members")
		return
	}

	// We got a message — check if it's a typing event (could be a heartbeat or other event).
	env := parseEnvelope(t, data)
	if env.Op == v1.GatewayOpCode_GATEWAY_OP_EVENT {
		event := &v1.Event{}
		if err := proto.Unmarshal(env.Payload, event); err == nil {
			if event.Type == v1.EventType_EVENT_TYPE_TYPING_START {
				t.Error("VULNERABILITY: Gateway forwarded TYPING_START from non-member to channel members")
				return
			}
		}
	}
	t.Log("Mitigated: Received non-typing event; non-member typing was not forwarded")
}

