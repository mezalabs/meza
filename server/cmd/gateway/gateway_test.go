package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	v1 "github.com/mezalabs/meza/gen/meza/v1"
	"github.com/mezalabs/meza/gen/meza/v1/mezav1connect"
	"github.com/mezalabs/meza/internal/auth"
	"github.com/mezalabs/meza/internal/models"
	"github.com/mezalabs/meza/internal/store"
	"github.com/mezalabs/meza/internal/subjects"
	"github.com/mezalabs/meza/internal/testutil"
	"github.com/nats-io/nats.go"
	"google.golang.org/protobuf/proto"
)

// mockChatStoreGW implements store.ChatStorer for gateway tests.
type mockChatStoreGW struct {
	mu       sync.Mutex
	channels map[string][]string // userID -> channelIDs
	members  map[string]map[string]bool
	servers  map[string]*models.Server
	chans    map[string]*models.Channel
}

func newMockChatStoreGW() *mockChatStoreGW {
	return &mockChatStoreGW{
		channels: make(map[string][]string),
		members:  make(map[string]map[string]bool),
		servers:  make(map[string]*models.Server),
		chans:    make(map[string]*models.Channel),
	}
}

func (m *mockChatStoreGW) GetUserChannels(_ context.Context, userID string) ([]string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.channels[userID], nil
}

func (m *mockChatStoreGW) CreateServer(_ context.Context, name, ownerID string, _ *string, _ bool) (*models.Server, error) {
	return nil, fmt.Errorf("not implemented")
}
func (m *mockChatStoreGW) GetServer(_ context.Context, serverID string) (*models.Server, error) {
	return nil, fmt.Errorf("not implemented")
}
func (m *mockChatStoreGW) ListServers(_ context.Context, _ string) ([]*models.Server, error) {
	return nil, nil
}
func (m *mockChatStoreGW) CreateChannel(_ context.Context, _, _ string, _ int, _ bool, _ string) (*models.Channel, error) {
	return nil, fmt.Errorf("not implemented")
}
func (m *mockChatStoreGW) GetChannel(_ context.Context, channelID string) (*models.Channel, error) {
	return nil, fmt.Errorf("not implemented")
}
func (m *mockChatStoreGW) ListChannels(_ context.Context, _, _ string) ([]*models.Channel, error) {
	return nil, nil
}
func (m *mockChatStoreGW) AddMember(_ context.Context, _, _ string) error {
	return fmt.Errorf("not implemented")
}
func (m *mockChatStoreGW) IsMember(_ context.Context, _, _ string) (bool, error) {
	return false, nil
}
func (m *mockChatStoreGW) RemoveMember(_ context.Context, _, _ string) error {
	return fmt.Errorf("not implemented")
}
func (m *mockChatStoreGW) GetMemberCount(_ context.Context, _ string) (int, error) {
	return 0, nil
}
func (m *mockChatStoreGW) GetChannelAndCheckMembership(_ context.Context, channelID, _ string) (*models.Channel, bool, error) {
	return nil, false, fmt.Errorf("not implemented")
}
func (m *mockChatStoreGW) UpdateChannel(_ context.Context, channelID string, name, topic *string, position *int, _ *bool, _ *int, _ *bool, _, _ *string) (*models.Channel, error) {
	return nil, fmt.Errorf("not implemented")
}
func (m *mockChatStoreGW) DeleteChannel(_ context.Context, channelID string) error {
	return fmt.Errorf("not implemented")
}
func (m *mockChatStoreGW) ListMembers(_ context.Context, _ string, _ string, _ int) ([]*models.Member, error) {
	return nil, nil
}
func (m *mockChatStoreGW) GetMember(_ context.Context, _, _ string) (*models.Member, error) {
	return nil, fmt.Errorf("not implemented")
}
func (m *mockChatStoreGW) AddChannelMember(_ context.Context, _, _ string) error {
	return fmt.Errorf("not implemented")
}
func (m *mockChatStoreGW) RemoveChannelMember(_ context.Context, _, _ string) error {
	return fmt.Errorf("not implemented")
}
func (m *mockChatStoreGW) ListChannelMembers(_ context.Context, _ string) ([]*models.Member, error) {
	return nil, fmt.Errorf("not implemented")
}
func (m *mockChatStoreGW) IsChannelMember(_ context.Context, _, _ string) (bool, error) {
	return false, nil
}
func (m *mockChatStoreGW) RemoveChannelMembersForServer(_ context.Context, _, _ string) error {
	return fmt.Errorf("not implemented")
}
func (m *mockChatStoreGW) ClearChannelMembers(_ context.Context, _ string) error {
	return fmt.Errorf("not implemented")
}
func (m *mockChatStoreGW) SetMemberTimeout(_ context.Context, _, _ string, _ *time.Time) error {
	return fmt.Errorf("not implemented")
}
func (m *mockChatStoreGW) SetMemberNickname(_ context.Context, _, _, _ string) error {
	return fmt.Errorf("not implemented")
}
func (m *mockChatStoreGW) CreateDMChannel(_ context.Context, _, _, _, _ string) (*models.Channel, bool, error) {
	return nil, false, nil
}
func (m *mockChatStoreGW) CreateGroupDMChannel(_ context.Context, _, _ string, _ []string) (*models.Channel, error) {
	return nil, nil
}
func (m *mockChatStoreGW) ListDMChannelsWithParticipants(_ context.Context, _ string) ([]*models.DMChannelWithParticipants, error) {
	return nil, nil
}
func (m *mockChatStoreGW) GetDMChannelByPairKey(_ context.Context, _, _ string) (*models.Channel, error) {
	return nil, nil
}
func (m *mockChatStoreGW) UpdateDMStatus(_ context.Context, _, _ string) error { return nil }
func (m *mockChatStoreGW) ListPendingDMRequests(_ context.Context, _ string) ([]*models.DMChannelWithParticipants, error) {
	return nil, nil
}
func (m *mockChatStoreGW) ShareAnyServer(_ context.Context, _, _ string) (bool, error) {
	return false, nil
}
func (m *mockChatStoreGW) GetMutualServers(_ context.Context, _, _ string) ([]*models.Server, error) {
	return nil, nil
}
func (m *mockChatStoreGW) GetDMOtherParticipantID(_ context.Context, _, _ string) (string, error) {
	return "", nil
}
func (m *mockChatStoreGW) ListMemberUserIDs(_ context.Context, _ string) ([]string, error) {
	return nil, nil
}
func (m *mockChatStoreGW) UpdateServer(_ context.Context, _ string, _, _, _, _ *string, _, _, _ *bool, _ *string) (*models.Server, error) {
	return nil, fmt.Errorf("not implemented")
}
func (m *mockChatStoreGW) AcknowledgeRules(_ context.Context, _, _ string) (time.Time, error) {
	return time.Time{}, fmt.Errorf("not implemented")
}
func (m *mockChatStoreGW) CompleteOnboarding(_ context.Context, _, _ string, _, _ []string) (time.Time, []string, []string, error) {
	return time.Time{}, nil, nil, fmt.Errorf("not implemented")
}
func (m *mockChatStoreGW) CheckRulesAcknowledged(_ context.Context, _, _ string) (bool, error) {
	return false, fmt.Errorf("not implemented")
}
func (m *mockChatStoreGW) GetDefaultChannels(_ context.Context, _ string) ([]*models.Channel, error) {
	return nil, fmt.Errorf("not implemented")
}
func (m *mockChatStoreGW) GetSelfAssignableRoles(_ context.Context, _ string) ([]*models.Role, error) {
	return nil, fmt.Errorf("not implemented")
}
func (m *mockChatStoreGW) CreateServerFromTemplate(_ context.Context, _ store.CreateServerFromTemplateParams) (*models.Server, []*models.Channel, []*models.Role, error) {
	return nil, nil, nil, fmt.Errorf("not implemented")
}
func (m *mockChatStoreGW) CountChannelMembers(_ context.Context, _ string) (int, error) {
	return 0, nil
}
func (m *mockChatStoreGW) ListChannelParticipantIDs(_ context.Context, _ string) ([]string, error) {
	return nil, nil
}
func (m *mockChatStoreGW) UpdateChannelPrivacy(_ context.Context, _ string, _, _ *string, _ *int, _ *bool, _ *int, _ *bool, _, _ *string, _ bool, _ string, _ int64) (*models.Channel, error) {
	return nil, fmt.Errorf("not implemented")
}
func (m *mockChatStoreGW) CreateVoiceChannelWithCompanion(_ context.Context, _, _ string, _ bool, _ string) (*models.Channel, *models.Channel, error) {
	return nil, nil, nil
}
func (m *mockChatStoreGW) DeleteChannelWithCompanion(_ context.Context, _, _ string) error {
	return nil
}
func (m *mockChatStoreGW) IsVoiceTextCompanion(_ context.Context, _ string) (bool, error) {
	return false, nil
}
func (m *mockChatStoreGW) UpdateCompanionChannel(_ context.Context, _ string, _, _ *string, _ *string) error {
	return nil
}
func (m *mockChatStoreGW) GetSystemMessageConfig(_ context.Context, _ string) (*models.ServerSystemMessageConfig, error) {
	return nil, fmt.Errorf("not implemented")
}
func (m *mockChatStoreGW) UpsertSystemMessageConfig(_ context.Context, _ string, _ store.UpsertSystemMessageConfigOpts) (*models.ServerSystemMessageConfig, error) {
	return nil, fmt.Errorf("not implemented")
}
func (m *mockChatStoreGW) SetPermissionsSynced(_ context.Context, _ string, _ bool) error {
	return nil
}
func (m *mockChatStoreGW) SyncChannelToCategory(_ context.Context, _, _ string) error {
	return nil
}
func (m *mockChatStoreGW) DeleteChannelGroupWithSnapshot(_ context.Context, _ string) error {
	return nil
}

// mockReadStateStoreGW implements store.ReadStateStorer for gateway tests.
type mockReadStateStoreGW struct{}

func (m *mockReadStateStoreGW) UpsertReadState(_ context.Context, _, _, _ string) error {
	return nil
}
func (m *mockReadStateStoreGW) GetReadState(_ context.Context, _, _ string) (*models.ReadState, error) {
	return nil, fmt.Errorf("not found")
}
func (m *mockReadStateStoreGW) GetReadStates(_ context.Context, _ string) ([]models.ReadState, error) {
	return nil, nil
}
func (m *mockReadStateStoreGW) MarkServerAsRead(_ context.Context, _ string, _ []string, _ []string) error {
	return nil
}

// mockMessageStoreGW implements store.MessageStorer for gateway tests.
type mockMessageStoreGW struct{}

func (m *mockMessageStoreGW) InsertMessage(_ context.Context, _ *models.Message) error { return nil }
func (m *mockMessageStoreGW) GetMessage(_ context.Context, _, _ string) (*models.Message, error) {
	return nil, fmt.Errorf("not found")
}
func (m *mockMessageStoreGW) GetMessages(_ context.Context, _ string, _ store.GetMessagesOpts) ([]*models.Message, bool, error) {
	return nil, false, nil
}
func (m *mockMessageStoreGW) EditMessage(_ context.Context, _, _ string, _ []byte, _, _ []string, _ bool, _ time.Time, _ uint32) error {
	return nil
}
func (m *mockMessageStoreGW) DeleteMessage(_ context.Context, _, _ string) error      { return nil }
func (m *mockMessageStoreGW) BulkDeleteMessages(_ context.Context, _ string, _ []string) error {
	return nil
}
func (m *mockMessageStoreGW) GetMessagesByIDs(_ context.Context, _ string, _ []string) (map[string]*models.Message, error) {
	return nil, nil
}
func (m *mockMessageStoreGW) CountMessagesAfter(_ context.Context, _, _ string) (int32, error) {
	return 0, nil
}
func (m *mockMessageStoreGW) SearchMessages(_ context.Context, _ store.SearchMessagesOpts) ([]*models.Message, bool, error) {
	return nil, false, nil
}
func (m *mockMessageStoreGW) InsertReplyIndex(_ context.Context, _, _, _, _ string, _ time.Time) error {
	return nil
}
func (m *mockMessageStoreGW) DeleteReplyIndex(_ context.Context, _, _, _ string) error { return nil }
func (m *mockMessageStoreGW) GetReplies(_ context.Context, _, _ string, _ int) ([]*models.ReplyEntry, int, error) {
	return nil, 0, nil
}

func setupGatewayTest(t *testing.T, userID string, channelIDs []string) (*httptest.Server, *nats.Conn, *Gateway, *mockChatStoreGW) {
	t.Helper()

	nc := testutil.StartTestNATS(t)
	chatStore := newMockChatStoreGW()
	chatStore.channels[userID] = channelIDs

	// Dummy chat client (won't be used in most tests)
	chatClient := mezav1connect.NewChatServiceClient(http.DefaultClient, "http://localhost:1")

	gw := NewGateway(chatStore, &mockReadStateStoreGW{}, &mockMessageStoreGW{}, chatClient, nc, "*", nil)
	gw.ed25519Keys = testutil.TestEd25519Keys
	gw.verificationCache = auth.NewVerificationCache()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	if err := gw.Start(ctx); err != nil {
		t.Fatalf("start gateway: %v", err)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/ws", gw.HandleWebSocket)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	return srv, nc, gw, chatStore
}

func dialWS(t *testing.T, srv *httptest.Server, userID string) *websocket.Conn {
	t.Helper()
	token, _, err := auth.GenerateTokenPairEd25519(userID, "device-1", testutil.TestEd25519Keys, "", false)
	if err != nil {
		t.Fatalf("generate token: %v", err)
	}

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws"
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	conn, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatalf("dial ws: %v", err)
	}
	t.Cleanup(func() { conn.CloseNow() })

	// Send IDENTIFY message with token (first-message auth)
	payload, _ := json.Marshal(map[string]string{"token": token})
	identifyMsg, err := makeEnvelope(v1.GatewayOpCode_GATEWAY_OP_IDENTIFY, payload)
	if err != nil {
		t.Fatalf("make identify envelope: %v", err)
	}
	if err := conn.Write(ctx, websocket.MessageBinary, identifyMsg); err != nil {
		t.Fatalf("write identify: %v", err)
	}

	return conn
}

func readEnvelope(t *testing.T, conn *websocket.Conn) *v1.GatewayEnvelope {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	_, data, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("read ws: %v", err)
	}

	env := &v1.GatewayEnvelope{}
	if err := proto.Unmarshal(data, env); err != nil {
		t.Fatalf("unmarshal envelope: %v", err)
	}
	return env
}

func TestWebSocketConnectReceivesReady(t *testing.T) {
	userID := models.NewID()
	channelIDs := []string{models.NewID(), models.NewID()}
	srv, _, _, _ := setupGatewayTest(t, userID, channelIDs)

	conn := dialWS(t, srv, userID)
	env := readEnvelope(t, conn)

	if env.Op != v1.GatewayOpCode_GATEWAY_OP_READY {
		t.Fatalf("op = %v, want READY", env.Op)
	}
	if len(env.Payload) == 0 {
		t.Error("expected non-empty READY payload")
	}
}

func TestWebSocketRejectsInvalidToken(t *testing.T) {
	userID := models.NewID()
	srv, _, _, _ := setupGatewayTest(t, userID, nil)

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws"
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	conn, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatalf("dial ws: %v", err)
	}
	defer conn.CloseNow()

	// Send IDENTIFY with invalid token
	payload, _ := json.Marshal(map[string]string{"token": "invalid-token"})
	identifyMsg, err := makeEnvelope(v1.GatewayOpCode_GATEWAY_OP_IDENTIFY, payload)
	if err != nil {
		t.Fatalf("make identify envelope: %v", err)
	}
	if err := conn.Write(ctx, websocket.MessageBinary, identifyMsg); err != nil {
		t.Fatalf("write identify: %v", err)
	}

	// Server should close the connection
	_, _, err = conn.Read(ctx)
	if err == nil {
		t.Fatal("expected error for invalid token")
	}
}

func TestWebSocketRejectsMissingToken(t *testing.T) {
	userID := models.NewID()
	srv, _, _, _ := setupGatewayTest(t, userID, nil)

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws"
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	conn, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatalf("dial ws: %v", err)
	}
	defer conn.CloseNow()

	// Send IDENTIFY with empty token
	payload, _ := json.Marshal(map[string]string{"token": ""})
	identifyMsg, err := makeEnvelope(v1.GatewayOpCode_GATEWAY_OP_IDENTIFY, payload)
	if err != nil {
		t.Fatalf("make identify envelope: %v", err)
	}
	if err := conn.Write(ctx, websocket.MessageBinary, identifyMsg); err != nil {
		t.Fatalf("write identify: %v", err)
	}

	// Server should close the connection
	_, _, err = conn.Read(ctx)
	if err == nil {
		t.Fatal("expected error for missing token")
	}
}

func TestHeartbeat(t *testing.T) {
	userID := models.NewID()
	srv, _, _, _ := setupGatewayTest(t, userID, nil)

	conn := dialWS(t, srv, userID)

	// Read READY first
	readEnvelope(t, conn)

	// Send HEARTBEAT
	hb, err := makeEnvelope(v1.GatewayOpCode_GATEWAY_OP_HEARTBEAT, nil)
	if err != nil {
		t.Fatalf("make heartbeat envelope: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := conn.Write(ctx, websocket.MessageBinary, hb); err != nil {
		t.Fatalf("write heartbeat: %v", err)
	}

	// Read HEARTBEAT_ACK
	env := readEnvelope(t, conn)
	if env.Op != v1.GatewayOpCode_GATEWAY_OP_HEARTBEAT_ACK {
		t.Errorf("op = %v, want HEARTBEAT_ACK", env.Op)
	}
}

func TestMessageDelivery(t *testing.T) {
	userID := models.NewID()
	channelID := models.NewID()
	srv, nc, _, _ := setupGatewayTest(t, userID, []string{channelID})

	conn := dialWS(t, srv, userID)

	// Read READY
	readEnvelope(t, conn)

	// Publish a message event to the channel's NATS subject
	eventData := []byte("test-event-data")
	if err := nc.Publish(subjects.DeliverChannel(channelID), eventData); err != nil {
		t.Fatalf("publish: %v", err)
	}
	nc.Flush()

	// Client should receive the event wrapped in an EVENT envelope
	env := readEnvelope(t, conn)
	if env.Op != v1.GatewayOpCode_GATEWAY_OP_EVENT {
		t.Errorf("op = %v, want EVENT", env.Op)
	}
}

func TestClientCleanupOnDisconnect(t *testing.T) {
	userID := models.NewID()
	channelID := models.NewID()
	srv, _, gw, _ := setupGatewayTest(t, userID, []string{channelID})

	conn := dialWS(t, srv, userID)
	readEnvelope(t, conn) // READY

	// Verify client is registered
	gw.mu.RLock()
	clientCount := len(gw.clients)
	channelCount := len(gw.channelClients[channelID])
	gw.mu.RUnlock()

	if clientCount != 1 {
		t.Errorf("clients = %d, want 1", clientCount)
	}
	if channelCount != 1 {
		t.Errorf("channel clients = %d, want 1", channelCount)
	}

	// Disconnect
	conn.Close(websocket.StatusNormalClosure, "bye")

	// Wait for cleanup
	time.Sleep(100 * time.Millisecond)

	gw.mu.RLock()
	clientCount = len(gw.clients)
	channelCount = len(gw.channelClients[channelID])
	gw.mu.RUnlock()

	if clientCount != 0 {
		t.Errorf("clients after disconnect = %d, want 0", clientCount)
	}
	if channelCount != 0 {
		t.Errorf("channel clients after disconnect = %d, want 0", channelCount)
	}
}

func TestRefreshClientChannelsOnMembershipChange(t *testing.T) {
	userID := models.NewID()
	initialChannel := models.NewID()
	srv, nc, gw, mockStore := setupGatewayTest(t, userID, []string{initialChannel})

	conn := dialWS(t, srv, userID)
	readEnvelope(t, conn) // READY

	// Verify initial state: client is subscribed to the initial channel.
	gw.mu.RLock()
	if _, ok := gw.channelClients[initialChannel]; !ok {
		t.Fatal("client should be registered in initial channel")
	}
	initialClients := len(gw.channelClients[initialChannel])
	gw.mu.RUnlock()
	if initialClients != 1 {
		t.Fatalf("initial channel client count = %d, want 1", initialClients)
	}

	// Simulate membership change: user joins a new server with a new channel
	// and leaves the old one. Update the mock store to reflect this.
	newChannel := models.NewID()
	mockStore.mu.Lock()
	mockStore.channels[userID] = []string{newChannel}
	mockStore.mu.Unlock()

	// Publish to the user's subscription subject to trigger refreshClientChannels.
	if err := nc.Publish(subjects.UserSubscription(userID), nil); err != nil {
		t.Fatalf("publish user subscription: %v", err)
	}
	nc.Flush()

	// Wait for debounce delay (150ms) + async NATS callback to process the refresh.
	time.Sleep(500 * time.Millisecond)

	// Verify: client should now be in the new channel and removed from the old one.
	gw.mu.RLock()
	oldChannelClients := len(gw.channelClients[initialChannel])
	newChannelClients := len(gw.channelClients[newChannel])
	gw.mu.RUnlock()

	if oldChannelClients != 0 {
		t.Errorf("old channel client count = %d, want 0", oldChannelClients)
	}
	if newChannelClients != 1 {
		t.Errorf("new channel client count = %d, want 1", newChannelClients)
	}

	// Verify the client's own channel list was updated.
	gw.mu.RLock()
	var client *Client
	for _, c := range gw.clients {
		if c.UserID == userID {
			client = c
			break
		}
	}
	gw.mu.RUnlock()

	if client == nil {
		t.Fatal("client not found in gateway")
	}
	if len(client.Channels) != 1 || client.Channels[0] != newChannel {
		t.Errorf("client.Channels = %v, want [%s]", client.Channels, newChannel)
	}

	// Verify a message published to the new channel is delivered to the client.
	eventData := []byte("test-event-after-refresh")
	if err := nc.Publish(subjects.DeliverChannel(newChannel), eventData); err != nil {
		t.Fatalf("publish to new channel: %v", err)
	}
	nc.Flush()

	env := readEnvelope(t, conn)
	if env.Op != v1.GatewayOpCode_GATEWAY_OP_EVENT {
		t.Errorf("op = %v, want EVENT", env.Op)
	}

	// Verify a message published to the OLD channel is NOT delivered.
	// We publish to the old channel, then send a heartbeat and expect only
	// the heartbeat ACK back — no event from the old channel.
	if err := nc.Publish(subjects.DeliverChannel(initialChannel), []byte("stale")); err != nil {
		t.Fatalf("publish to old channel: %v", err)
	}
	nc.Flush()

	hb, err := makeEnvelope(v1.GatewayOpCode_GATEWAY_OP_HEARTBEAT, nil)
	if err != nil {
		t.Fatalf("make heartbeat envelope: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := conn.Write(ctx, websocket.MessageBinary, hb); err != nil {
		t.Fatalf("write heartbeat: %v", err)
	}

	env = readEnvelope(t, conn)
	if env.Op != v1.GatewayOpCode_GATEWAY_OP_HEARTBEAT_ACK {
		t.Errorf("expected HEARTBEAT_ACK after old-channel publish, got op=%v", env.Op)
	}
}
