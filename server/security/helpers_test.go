//go:build integration

// Package security contains security tests that run against live Meza services.
// These tests validate security vulnerabilities identified during pre-launch audit.
//
// Prerequisites:
//   - Running local stack: task start
//   - All service ports accessible: 8080-8087, 9000 (MinIO)
//
// Run:
//
//	cd server && go test -tags integration -v -count=1 ./security/...
package security

import (
	"context"
	"crypto/rand"
	"fmt"
	"net/http"
	"os"
	"testing"
	"time"

	"connectrpc.com/connect"
	v1 "github.com/meza-chat/meza/gen/meza/v1"
	"github.com/meza-chat/meza/gen/meza/v1/mezav1connect"
)

// Service URLs — override with environment variables for non-default ports.
var (
	authURL         = envOrDefault("AUTH_URL", "http://localhost:8081")
	chatURL         = envOrDefault("CHAT_URL", "http://localhost:8082")
	presenceURL     = envOrDefault("PRESENCE_URL", "http://localhost:8083")
	mediaURL        = envOrDefault("MEDIA_URL", "http://localhost:8084")
	voiceURL        = envOrDefault("VOICE_URL", "http://localhost:8085")
	notificationURL = envOrDefault("NOTIFICATION_URL", "http://localhost:8086")
	gatewayURL      = envOrDefault("GATEWAY_URL", "http://localhost:8080")
	gatewayWSURL    = envOrDefault("GATEWAY_WS_URL", "ws://localhost:8080")
	minioURL        = envOrDefault("MINIO_URL", "http://localhost:9000")
)

func envOrDefault(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// testUser holds the credentials and tokens for a registered test user.
type testUser struct {
	Email        string
	Username     string
	AuthKey      []byte
	AccessToken  string
	RefreshToken string
	UserID       string
}

// registerUser creates a new user via the Register RPC and returns their credentials.
func registerUser(t *testing.T, suffix string) testUser {
	t.Helper()
	authKey := makeRandomBytes(t, 32)
	salt := makeRandomBytes(t, 16)
	keyBundle := makeRandomBytes(t, 64)
	keyBundleIV := makeRandomBytes(t, 12)

	email := fmt.Sprintf("security_%s@test.meza.local", suffix)
	username := fmt.Sprintf("pt_%s", suffix)
	// Truncate username to 20 chars max (validation constraint)
	if len(username) > 20 {
		username = username[:20]
	}

	client := newAuthClient()
	req := connect.NewRequest(&v1.RegisterRequest{
		Email:              email,
		Username:           username,
		AuthKey:            authKey,
		Salt:               salt,
		EncryptedKeyBundle: keyBundle,
		KeyBundleIv:        keyBundleIV,
	})

	var resp *connect.Response[v1.RegisterResponse]
	var err error
	for attempt := 0; attempt < 5; attempt++ {
		resp, err = client.Register(context.Background(), req)
		if err == nil {
			break
		}
		if connect.CodeOf(err) == connect.CodeResourceExhausted {
			time.Sleep(time.Duration(attempt+1) * 500 * time.Millisecond)
			continue
		}
		break // non-rate-limit error
	}
	if err != nil {
		t.Fatalf("registerUser(%s): %v", suffix, err)
	}

	return testUser{
		Email:        email,
		Username:     username,
		AuthKey:      authKey,
		AccessToken:  resp.Msg.AccessToken,
		RefreshToken: resp.Msg.RefreshToken,
		UserID:       resp.Msg.User.Id,
	}
}

// authedRequest creates a connect.Request with Bearer token authorization.
func authedRequest[T any](token string, msg *T) *connect.Request[T] {
	req := connect.NewRequest(msg)
	req.Header().Set("Authorization", "Bearer "+token)
	return req
}

// makeRandomBytes generates n cryptographically random bytes.
func makeRandomBytes(t *testing.T, n int) []byte {
	t.Helper()
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		t.Fatalf("makeRandomBytes(%d): %v", n, err)
	}
	return b
}

// uniqueSuffix returns a short random hex string for unique test data.
func uniqueSuffix(t *testing.T) string {
	t.Helper()
	b := make([]byte, 6)
	if _, err := rand.Read(b); err != nil {
		t.Fatalf("uniqueSuffix: %v", err)
	}
	return fmt.Sprintf("%x", b)
}

// --- Service client constructors ---

func newAuthClient() mezav1connect.AuthServiceClient {
	return mezav1connect.NewAuthServiceClient(http.DefaultClient, authURL)
}

func newChatClient() mezav1connect.ChatServiceClient {
	return mezav1connect.NewChatServiceClient(http.DefaultClient, chatURL)
}

func newPresenceClient() mezav1connect.PresenceServiceClient {
	return mezav1connect.NewPresenceServiceClient(http.DefaultClient, presenceURL)
}

func newMediaClient() mezav1connect.MediaServiceClient {
	return mezav1connect.NewMediaServiceClient(http.DefaultClient, mediaURL)
}

func newVoiceClient() mezav1connect.VoiceServiceClient {
	return mezav1connect.NewVoiceServiceClient(http.DefaultClient, voiceURL)
}

// --- Higher-level helpers ---

// mustCreateServer creates a test server and returns the server ID.
func mustCreateServer(t *testing.T, token string) string {
	t.Helper()
	chat := newChatClient()
	resp, err := chat.CreateServer(context.Background(), authedRequest(token, &v1.CreateServerRequest{
		Name: "security-server-" + uniqueSuffix(t),
	}))
	if err != nil {
		t.Fatalf("mustCreateServer: %v", err)
	}
	return resp.Msg.Server.Id
}

// mustCreateChannel creates a text channel in a server and returns the channel ID.
func mustCreateChannel(t *testing.T, token, serverID string) string {
	t.Helper()
	chat := newChatClient()
	resp, err := chat.CreateChannel(context.Background(), authedRequest(token, &v1.CreateChannelRequest{
		ServerId: serverID,
		Name:     "security-channel-" + uniqueSuffix(t),
		Type:     v1.ChannelType_CHANNEL_TYPE_TEXT,
	}))
	if err != nil {
		t.Fatalf("mustCreateChannel: %v", err)
	}
	return resp.Msg.Channel.Id
}

// mustCreateInvite creates an invite for a server and returns the invite code.
func mustCreateInvite(t *testing.T, token, serverID string) string {
	t.Helper()
	chat := newChatClient()
	resp, err := chat.CreateInvite(context.Background(), authedRequest(token, &v1.CreateInviteRequest{
		ServerId: serverID,
	}))
	if err != nil {
		t.Fatalf("mustCreateInvite: %v", err)
	}
	return resp.Msg.Invite.Code
}

// mustJoinServer joins a server via invite code.
func mustJoinServer(t *testing.T, token, inviteCode string) {
	t.Helper()
	chat := newChatClient()
	_, err := chat.JoinServer(context.Background(), authedRequest(token, &v1.JoinServerRequest{
		InviteCode: inviteCode,
	}))
	if err != nil {
		t.Fatalf("mustJoinServer: %v", err)
	}
}

// mustSendMessage sends a message to a channel and returns the message ID.
func mustSendMessage(t *testing.T, token, channelID string, content []byte) string {
	t.Helper()
	chat := newChatClient()
	resp, err := chat.SendMessage(context.Background(), authedRequest(token, &v1.SendMessageRequest{
		ChannelId:        channelID,
		EncryptedContent: content,
		Nonce:            uniqueSuffix(t),
	}))
	if err != nil {
		t.Fatalf("mustSendMessage: %v", err)
	}
	return resp.Msg.MessageId
}
