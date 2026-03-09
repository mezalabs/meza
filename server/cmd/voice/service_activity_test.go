package main

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"connectrpc.com/connect"
	"github.com/livekit/protocol/livekit"
	v1 "github.com/mezalabs/meza/gen/meza/v1"
	"github.com/mezalabs/meza/gen/meza/v1/mezav1connect"
	"github.com/mezalabs/meza/internal/auth"
	"github.com/mezalabs/meza/internal/models"
	"github.com/mezalabs/meza/internal/testutil"
)

func TestGetUserVoiceActivity_Unauthenticated(t *testing.T) {
	client, _, _, _ := setupVoiceTest(t)

	_, err := client.GetUserVoiceActivity(context.Background(), connect.NewRequest(&v1.GetUserVoiceActivityRequest{
		UserId: models.NewID(),
	}))
	if err == nil {
		t.Fatal("expected error for unauthenticated request, got nil")
	}

	var connErr *connect.Error
	if !errors.As(err, &connErr) {
		t.Fatalf("expected connect.Error, got %T", err)
	}
	if connErr.Code() != connect.CodeUnauthenticated {
		t.Errorf("code = %v, want %v", connErr.Code(), connect.CodeUnauthenticated)
	}
}

func TestGetUserVoiceActivity_MissingUserID(t *testing.T) {
	client, _, _, _ := setupVoiceTest(t)
	callerID := models.NewID()

	_, err := client.GetUserVoiceActivity(context.Background(), testutil.AuthedRequest(t, callerID, &v1.GetUserVoiceActivityRequest{
		UserId: "",
	}))
	if err == nil {
		t.Fatal("expected error for missing user_id, got nil")
	}
	if connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Errorf("code = %v, want %v", connect.CodeOf(err), connect.CodeInvalidArgument)
	}
}

func TestGetUserVoiceActivity_BlockedReturnsEmpty(t *testing.T) {
	cs := newMockChatStore()
	rs := newMockRoleStore()
	bs := newMockBlockStore()
	lk := newMockLKClient()

	callerID := models.NewID()
	targetID := models.NewID()
	serverID := models.NewID()
	channelID := models.NewID()

	cs.addServer(&models.Server{ID: serverID, Name: "Test Server"})
	cs.addChannel(&models.Channel{ID: channelID, ServerID: serverID, Name: "voice", Type: channelTypeVoice})
	cs.addMember(serverID, callerID)
	cs.addMember(serverID, targetID)

	room := "meza-" + channelID
	lk.rooms[room] = true
	lk.participants[room] = []*livekit.ParticipantInfo{{Identity: targetID}}

	// Block the target.
	bs.blocked[callerID+":"+targetID] = true

	client, _ := setupVoiceTestWithStores(t, cs, rs, bs, lk)
	resp, err := client.GetUserVoiceActivity(context.Background(), testutil.AuthedRequest(t, callerID, &v1.GetUserVoiceActivityRequest{
		UserId: targetID,
	}))
	if err != nil {
		t.Fatalf("GetUserVoiceActivity: %v", err)
	}
	if len(resp.Msg.Activities) != 0 {
		t.Errorf("expected 0 activities for blocked user, got %d", len(resp.Msg.Activities))
	}
}

func TestGetUserVoiceActivity_NoMutualServersReturnsEmpty(t *testing.T) {
	client, _, _, _ := setupVoiceTest(t)

	callerID := models.NewID()
	targetID := models.NewID()

	// No servers set up — no mutual servers.
	resp, err := client.GetUserVoiceActivity(context.Background(), testutil.AuthedRequest(t, callerID, &v1.GetUserVoiceActivityRequest{
		UserId: targetID,
	}))
	if err != nil {
		t.Fatalf("GetUserVoiceActivity: %v", err)
	}
	if len(resp.Msg.Activities) != 0 {
		t.Errorf("expected 0 activities with no mutual servers, got %d", len(resp.Msg.Activities))
	}
}

func TestGetUserVoiceActivity_HappyPath(t *testing.T) {
	cs := newMockChatStore()
	rs := newMockRoleStore()
	bs := newMockBlockStore()
	lk := newMockLKClient()

	callerID := models.NewID()
	targetID := models.NewID()
	serverID := models.NewID()
	channelID := models.NewID()

	cs.addServer(&models.Server{ID: serverID, Name: "Test Server"})
	cs.addChannel(&models.Channel{ID: channelID, ServerID: serverID, Name: "voice-chat", Type: channelTypeVoice})
	cs.addMember(serverID, callerID)
	cs.addMember(serverID, targetID)

	room := "meza-" + channelID
	lk.rooms[room] = true
	lk.participants[room] = []*livekit.ParticipantInfo{
		{
			Identity: targetID,
			Tracks: []*livekit.TrackInfo{
				{Source: livekit.TrackSource_MICROPHONE},
			},
		},
	}

	client, _ := setupVoiceTestWithStores(t, cs, rs, bs, lk)
	resp, err := client.GetUserVoiceActivity(context.Background(), testutil.AuthedRequest(t, callerID, &v1.GetUserVoiceActivityRequest{
		UserId: targetID,
	}))
	if err != nil {
		t.Fatalf("GetUserVoiceActivity: %v", err)
	}

	if len(resp.Msg.Activities) != 1 {
		t.Fatalf("expected 1 activity, got %d", len(resp.Msg.Activities))
	}
	act := resp.Msg.Activities[0]
	if act.ChannelId != channelID {
		t.Errorf("ChannelId = %q, want %q", act.ChannelId, channelID)
	}
	if act.ChannelName != "voice-chat" {
		t.Errorf("ChannelName = %q, want %q", act.ChannelName, "voice-chat")
	}
	if act.ServerId != serverID {
		t.Errorf("ServerId = %q, want %q", act.ServerId, serverID)
	}
	if act.ServerName != "Test Server" {
		t.Errorf("ServerName = %q, want %q", act.ServerName, "Test Server")
	}
	if act.IsStreamingVideo {
		t.Error("expected IsStreamingVideo = false (no screen share track)")
	}
}

func TestGetUserVoiceActivity_ScreenShareDetected(t *testing.T) {
	cs := newMockChatStore()
	rs := newMockRoleStore()
	bs := newMockBlockStore()
	lk := newMockLKClient()

	callerID := models.NewID()
	targetID := models.NewID()
	serverID := models.NewID()
	channelID := models.NewID()

	cs.addServer(&models.Server{ID: serverID, Name: "Srv"})
	cs.addChannel(&models.Channel{ID: channelID, ServerID: serverID, Name: "voice", Type: channelTypeVoice})
	cs.addMember(serverID, callerID)
	cs.addMember(serverID, targetID)

	room := "meza-" + channelID
	lk.rooms[room] = true
	lk.participants[room] = []*livekit.ParticipantInfo{
		{
			Identity: targetID,
			Tracks: []*livekit.TrackInfo{
				{Source: livekit.TrackSource_MICROPHONE},
				{Source: livekit.TrackSource_SCREEN_SHARE},
			},
		},
	}

	client, _ := setupVoiceTestWithStores(t, cs, rs, bs, lk)
	resp, err := client.GetUserVoiceActivity(context.Background(), testutil.AuthedRequest(t, callerID, &v1.GetUserVoiceActivityRequest{
		UserId: targetID,
	}))
	if err != nil {
		t.Fatalf("GetUserVoiceActivity: %v", err)
	}
	if len(resp.Msg.Activities) != 1 {
		t.Fatalf("expected 1 activity, got %d", len(resp.Msg.Activities))
	}
	if !resp.Msg.Activities[0].IsStreamingVideo {
		t.Error("expected IsStreamingVideo = true (screen share track present)")
	}
}

func TestGetUserVoiceActivity_UserNotInVoice(t *testing.T) {
	cs := newMockChatStore()
	rs := newMockRoleStore()
	bs := newMockBlockStore()
	lk := newMockLKClient()

	callerID := models.NewID()
	targetID := models.NewID()
	serverID := models.NewID()
	channelID := models.NewID()

	cs.addServer(&models.Server{ID: serverID, Name: "Srv"})
	cs.addChannel(&models.Channel{ID: channelID, ServerID: serverID, Name: "voice", Type: channelTypeVoice})
	cs.addMember(serverID, callerID)
	cs.addMember(serverID, targetID)

	// Room exists but target is NOT a participant.
	room := "meza-" + channelID
	lk.rooms[room] = true
	lk.participants[room] = []*livekit.ParticipantInfo{}

	client, _ := setupVoiceTestWithStores(t, cs, rs, bs, lk)
	resp, err := client.GetUserVoiceActivity(context.Background(), testutil.AuthedRequest(t, callerID, &v1.GetUserVoiceActivityRequest{
		UserId: targetID,
	}))
	if err != nil {
		t.Fatalf("GetUserVoiceActivity: %v", err)
	}
	if len(resp.Msg.Activities) != 0 {
		t.Errorf("expected 0 activities when user not in voice, got %d", len(resp.Msg.Activities))
	}
}

// setupVoiceTestWithStores is like setupVoiceTest but accepts explicit stores
// so tests can pre-configure blocks and other state.
func setupVoiceTestWithStores(
	t *testing.T,
	cs *mockChatStore,
	rs *mockRoleStore,
	bs *mockBlockStore,
	lk *mockLKClient,
) (mezav1connect.VoiceServiceClient, *mockLKClient) {
	t.Helper()

	svc := &voiceService{
		chatStore:   cs,
		roleStore:   rs,
		blockStore:  bs,
		lkClient:    lk,
		lkKey:       "test-api-key",
		lkSecret:    "test-api-secret-that-is-long-enough",
		lkHost:      "wss://lk.example.com",
		lkPublicURL: "wss://lk.example.com",
	}

	interceptor := connect.WithInterceptors(auth.NewConnectInterceptor(testutil.TestEd25519Keys.PublicKey))
	mux := http.NewServeMux()
	path, handler := mezav1connect.NewVoiceServiceHandler(svc, interceptor)
	mux.Handle(path, handler)

	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	client := mezav1connect.NewVoiceServiceClient(http.DefaultClient, srv.URL)
	return client, lk
}
