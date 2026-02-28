package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/alicebob/miniredis/v2"
	v1 "github.com/meza-chat/meza/gen/meza/v1"
	"github.com/meza-chat/meza/gen/meza/v1/mezav1connect"
	"github.com/meza-chat/meza/internal/auth"
	"github.com/meza-chat/meza/internal/models"
	"github.com/meza-chat/meza/internal/subjects"
	"github.com/meza-chat/meza/internal/testutil"
	"github.com/nats-io/nats.go"
	"github.com/redis/go-redis/v9"
	"google.golang.org/protobuf/proto"
)

// mockMembershipChecker always reports that users share a server.
type mockMembershipChecker struct{}

func (m *mockMembershipChecker) ShareAnyServer(_ context.Context, _, _ string) (bool, error) {
	return true, nil
}

func setupPresenceTest(t *testing.T) (mezav1connect.PresenceServiceClient, *miniredis.Miniredis, *nats.Conn) {
	t.Helper()

	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { rdb.Close() })

	nc := testutil.StartTestNATS(t)
	svc := newPresenceService(rdb, nc, &mockMembershipChecker{})

	sub, err := svc.StartHeartbeatConsumer()
	if err != nil {
		t.Fatalf("start heartbeat consumer: %v", err)
	}
	t.Cleanup(func() { sub.Unsubscribe() })

	interceptor := connect.WithInterceptors(auth.NewConnectInterceptor(testutil.TestEd25519Keys.PublicKey))
	mux := http.NewServeMux()
	path, handler := mezav1connect.NewPresenceServiceHandler(svc, interceptor)
	mux.Handle(path, handler)

	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	client := mezav1connect.NewPresenceServiceClient(http.DefaultClient, srv.URL)
	return client, mr, nc
}

func TestUpdateAndGetPresence(t *testing.T) {
	client, _, _ := setupPresenceTest(t)
	userID := models.NewID()

	_, err := client.UpdatePresence(context.Background(), testutil.AuthedRequest(t, userID, &v1.UpdatePresenceRequest{
		Status: v1.PresenceStatus_PRESENCE_STATUS_ONLINE,
	}))
	if err != nil {
		t.Fatalf("UpdatePresence: %v", err)
	}

	resp, err := client.GetPresence(context.Background(), testutil.AuthedRequest(t, userID, &v1.GetPresenceRequest{
		UserId: userID,
	}))
	if err != nil {
		t.Fatalf("GetPresence: %v", err)
	}
	if resp.Msg.Status != v1.PresenceStatus_PRESENCE_STATUS_ONLINE {
		t.Errorf("status = %v, want ONLINE", resp.Msg.Status)
	}
}

func TestGetPresenceOffline(t *testing.T) {
	client, _, _ := setupPresenceTest(t)
	userID := models.NewID()

	resp, err := client.GetPresence(context.Background(), testutil.AuthedRequest(t, userID, &v1.GetPresenceRequest{
		UserId: userID,
	}))
	if err != nil {
		t.Fatalf("GetPresence: %v", err)
	}
	if resp.Msg.Status != v1.PresenceStatus_PRESENCE_STATUS_OFFLINE {
		t.Errorf("status = %v, want OFFLINE", resp.Msg.Status)
	}
}

func TestTTLExpiry(t *testing.T) {
	client, mr, _ := setupPresenceTest(t)
	userID := models.NewID()

	_, err := client.UpdatePresence(context.Background(), testutil.AuthedRequest(t, userID, &v1.UpdatePresenceRequest{
		Status: v1.PresenceStatus_PRESENCE_STATUS_ONLINE,
	}))
	if err != nil {
		t.Fatalf("UpdatePresence: %v", err)
	}

	// Fast-forward time in miniredis past the TTL
	mr.FastForward(61 * time.Second)

	resp, err := client.GetPresence(context.Background(), testutil.AuthedRequest(t, userID, &v1.GetPresenceRequest{
		UserId: userID,
	}))
	if err != nil {
		t.Fatalf("GetPresence: %v", err)
	}
	if resp.Msg.Status != v1.PresenceStatus_PRESENCE_STATUS_OFFLINE {
		t.Errorf("status = %v, want OFFLINE after TTL", resp.Msg.Status)
	}
}

func TestGetBulkPresence(t *testing.T) {
	client, _, _ := setupPresenceTest(t)
	userOnline := models.NewID()
	userOffline := models.NewID()

	_, err := client.UpdatePresence(context.Background(), testutil.AuthedRequest(t, userOnline, &v1.UpdatePresenceRequest{
		Status: v1.PresenceStatus_PRESENCE_STATUS_DND,
	}))
	if err != nil {
		t.Fatalf("UpdatePresence: %v", err)
	}

	resp, err := client.GetBulkPresence(context.Background(), testutil.AuthedRequest(t, userOnline, &v1.GetBulkPresenceRequest{
		UserIds: []string{userOnline, userOffline},
	}))
	if err != nil {
		t.Fatalf("GetBulkPresence: %v", err)
	}
	if len(resp.Msg.Presences) != 2 {
		t.Fatalf("presences count = %d, want 2", len(resp.Msg.Presences))
	}

	var onlineResult, offlineResult *v1.GetPresenceResponse
	for _, p := range resp.Msg.Presences {
		if p.UserId == userOnline {
			onlineResult = p
		} else {
			offlineResult = p
		}
	}

	if onlineResult == nil || onlineResult.Status != v1.PresenceStatus_PRESENCE_STATUS_DND {
		t.Errorf("online user status = %v, want DND", onlineResult)
	}
	if offlineResult == nil || offlineResult.Status != v1.PresenceStatus_PRESENCE_STATUS_OFFLINE {
		t.Errorf("offline user status = %v, want OFFLINE", offlineResult)
	}
}

func TestHeartbeatExtendsTTL(t *testing.T) {
	client, mr, nc := setupPresenceTest(t)
	userID := models.NewID()

	_, err := client.UpdatePresence(context.Background(), testutil.AuthedRequest(t, userID, &v1.UpdatePresenceRequest{
		Status: v1.PresenceStatus_PRESENCE_STATUS_ONLINE,
	}))
	if err != nil {
		t.Fatalf("UpdatePresence: %v", err)
	}

	// Fast-forward 50s (within TTL)
	mr.FastForward(50 * time.Second)

	// Send heartbeat via NATS (simulating what gateway does)
	nc.Publish(subjects.PresenceHeartbeat(userID), nil)
	nc.Flush()
	time.Sleep(50 * time.Millisecond) // let NATS handler process

	// Fast-forward another 50s (would be past original TTL, but heartbeat renewed it)
	mr.FastForward(50 * time.Second)

	resp, err := client.GetPresence(context.Background(), testutil.AuthedRequest(t, userID, &v1.GetPresenceRequest{
		UserId: userID,
	}))
	if err != nil {
		t.Fatalf("GetPresence: %v", err)
	}
	if resp.Msg.Status != v1.PresenceStatus_PRESENCE_STATUS_ONLINE {
		t.Errorf("status = %v, want ONLINE (heartbeat should have extended TTL)", resp.Msg.Status)
	}
}

func TestSetStatusOverrideDND(t *testing.T) {
	client, _, _ := setupPresenceTest(t)
	userID := models.NewID()
	otherUserID := models.NewID()

	// Set user online first
	_, err := client.UpdatePresence(context.Background(), testutil.AuthedRequest(t, userID, &v1.UpdatePresenceRequest{
		Status: v1.PresenceStatus_PRESENCE_STATUS_ONLINE,
	}))
	if err != nil {
		t.Fatalf("UpdatePresence: %v", err)
	}

	// Set DND override
	overrideResp, err := client.SetStatusOverride(context.Background(), testutil.AuthedRequest(t, userID, &v1.SetStatusOverrideRequest{
		Status: v1.PresenceStatus_PRESENCE_STATUS_DND,
	}))
	if err != nil {
		t.Fatalf("SetStatusOverride: %v", err)
	}
	if overrideResp.Msg.Status != v1.PresenceStatus_PRESENCE_STATUS_DND {
		t.Errorf("override status = %v, want DND", overrideResp.Msg.Status)
	}
	if overrideResp.Msg.ExpiresAt != 0 {
		t.Errorf("expires_at = %d, want 0 (indefinite)", overrideResp.Msg.ExpiresAt)
	}

	// Other user should see DND
	resp, err := client.GetPresence(context.Background(), testutil.AuthedRequest(t, otherUserID, &v1.GetPresenceRequest{
		UserId: userID,
	}))
	if err != nil {
		t.Fatalf("GetPresence: %v", err)
	}
	if resp.Msg.Status != v1.PresenceStatus_PRESENCE_STATUS_DND {
		t.Errorf("status seen by other = %v, want DND", resp.Msg.Status)
	}
}

func TestSetStatusOverrideInvisible(t *testing.T) {
	client, _, _ := setupPresenceTest(t)
	userID := models.NewID()
	otherUserID := models.NewID()

	// Set user online first
	_, err := client.UpdatePresence(context.Background(), testutil.AuthedRequest(t, userID, &v1.UpdatePresenceRequest{
		Status: v1.PresenceStatus_PRESENCE_STATUS_ONLINE,
	}))
	if err != nil {
		t.Fatalf("UpdatePresence: %v", err)
	}

	// Set INVISIBLE override
	_, err = client.SetStatusOverride(context.Background(), testutil.AuthedRequest(t, userID, &v1.SetStatusOverrideRequest{
		Status: v1.PresenceStatus_PRESENCE_STATUS_INVISIBLE,
	}))
	if err != nil {
		t.Fatalf("SetStatusOverride: %v", err)
	}

	// Other user should see OFFLINE (not INVISIBLE)
	resp, err := client.GetPresence(context.Background(), testutil.AuthedRequest(t, otherUserID, &v1.GetPresenceRequest{
		UserId: userID,
	}))
	if err != nil {
		t.Fatalf("GetPresence: %v", err)
	}
	if resp.Msg.Status != v1.PresenceStatus_PRESENCE_STATUS_OFFLINE {
		t.Errorf("status seen by other = %v, want OFFLINE", resp.Msg.Status)
	}

	// Self should see INVISIBLE
	selfResp, err := client.GetPresence(context.Background(), testutil.AuthedRequest(t, userID, &v1.GetPresenceRequest{
		UserId: userID,
	}))
	if err != nil {
		t.Fatalf("GetPresence self: %v", err)
	}
	if selfResp.Msg.Status != v1.PresenceStatus_PRESENCE_STATUS_INVISIBLE {
		t.Errorf("status seen by self = %v, want INVISIBLE", selfResp.Msg.Status)
	}
}

func TestSetStatusOverrideInvalidStatus(t *testing.T) {
	client, _, _ := setupPresenceTest(t)
	userID := models.NewID()

	_, err := client.SetStatusOverride(context.Background(), testutil.AuthedRequest(t, userID, &v1.SetStatusOverrideRequest{
		Status: v1.PresenceStatus_PRESENCE_STATUS_ONLINE,
	}))
	if err == nil {
		t.Fatal("expected error for invalid override status")
	}
	if connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Errorf("error code = %v, want InvalidArgument", connect.CodeOf(err))
	}
}

func TestSetStatusOverrideWithDuration(t *testing.T) {
	client, _, _ := setupPresenceTest(t)
	userID := models.NewID()

	// Set user online first
	_, err := client.UpdatePresence(context.Background(), testutil.AuthedRequest(t, userID, &v1.UpdatePresenceRequest{
		Status: v1.PresenceStatus_PRESENCE_STATUS_ONLINE,
	}))
	if err != nil {
		t.Fatalf("UpdatePresence: %v", err)
	}

	// Set DND with 1 hour duration
	overrideResp, err := client.SetStatusOverride(context.Background(), testutil.AuthedRequest(t, userID, &v1.SetStatusOverrideRequest{
		Status:          v1.PresenceStatus_PRESENCE_STATUS_DND,
		DurationSeconds: 3600,
	}))
	if err != nil {
		t.Fatalf("SetStatusOverride: %v", err)
	}
	if overrideResp.Msg.ExpiresAt == 0 {
		t.Error("expires_at should not be 0 when duration is set")
	}

	// Verify via GetMyPresence
	myResp, err := client.GetMyPresence(context.Background(), testutil.AuthedRequest(t, userID, &v1.GetMyPresenceRequest{}))
	if err != nil {
		t.Fatalf("GetMyPresence: %v", err)
	}
	if myResp.Msg.OverrideStatus != v1.PresenceStatus_PRESENCE_STATUS_DND {
		t.Errorf("override_status = %v, want DND", myResp.Msg.OverrideStatus)
	}
	if myResp.Msg.OverrideExpiresAt != overrideResp.Msg.ExpiresAt {
		t.Errorf("override_expires_at = %d, want %d", myResp.Msg.OverrideExpiresAt, overrideResp.Msg.ExpiresAt)
	}
}

func TestClearStatusOverride(t *testing.T) {
	client, _, _ := setupPresenceTest(t)
	userID := models.NewID()
	otherUserID := models.NewID()

	// Set online then DND override
	_, err := client.UpdatePresence(context.Background(), testutil.AuthedRequest(t, userID, &v1.UpdatePresenceRequest{
		Status: v1.PresenceStatus_PRESENCE_STATUS_ONLINE,
	}))
	if err != nil {
		t.Fatalf("UpdatePresence: %v", err)
	}
	_, err = client.SetStatusOverride(context.Background(), testutil.AuthedRequest(t, userID, &v1.SetStatusOverrideRequest{
		Status: v1.PresenceStatus_PRESENCE_STATUS_DND,
	}))
	if err != nil {
		t.Fatalf("SetStatusOverride: %v", err)
	}

	// Clear the override
	_, err = client.ClearStatusOverride(context.Background(), testutil.AuthedRequest(t, userID, &v1.ClearStatusOverrideRequest{}))
	if err != nil {
		t.Fatalf("ClearStatusOverride: %v", err)
	}

	// Other user should now see ONLINE
	resp, err := client.GetPresence(context.Background(), testutil.AuthedRequest(t, otherUserID, &v1.GetPresenceRequest{
		UserId: userID,
	}))
	if err != nil {
		t.Fatalf("GetPresence: %v", err)
	}
	if resp.Msg.Status != v1.PresenceStatus_PRESENCE_STATUS_ONLINE {
		t.Errorf("status = %v, want ONLINE after clearing override", resp.Msg.Status)
	}

	// GetMyPresence should show no override
	myResp, err := client.GetMyPresence(context.Background(), testutil.AuthedRequest(t, userID, &v1.GetMyPresenceRequest{}))
	if err != nil {
		t.Fatalf("GetMyPresence: %v", err)
	}
	if myResp.Msg.OverrideStatus != v1.PresenceStatus_PRESENCE_STATUS_UNSPECIFIED {
		t.Errorf("override_status = %v, want UNSPECIFIED (cleared)", myResp.Msg.OverrideStatus)
	}
}

func TestGetMyPresenceNoOverride(t *testing.T) {
	client, _, _ := setupPresenceTest(t)
	userID := models.NewID()

	// Set online
	_, err := client.UpdatePresence(context.Background(), testutil.AuthedRequest(t, userID, &v1.UpdatePresenceRequest{
		Status: v1.PresenceStatus_PRESENCE_STATUS_ONLINE,
	}))
	if err != nil {
		t.Fatalf("UpdatePresence: %v", err)
	}

	myResp, err := client.GetMyPresence(context.Background(), testutil.AuthedRequest(t, userID, &v1.GetMyPresenceRequest{}))
	if err != nil {
		t.Fatalf("GetMyPresence: %v", err)
	}
	if myResp.Msg.Status != v1.PresenceStatus_PRESENCE_STATUS_ONLINE {
		t.Errorf("status = %v, want ONLINE", myResp.Msg.Status)
	}
	if myResp.Msg.OverrideStatus != v1.PresenceStatus_PRESENCE_STATUS_UNSPECIFIED {
		t.Errorf("override_status = %v, want UNSPECIFIED", myResp.Msg.OverrideStatus)
	}
}

func TestOverrideExpiryViaGetMyPresence(t *testing.T) {
	client, _, _ := setupPresenceTest(t)
	userID := models.NewID()

	// Set online, then DND override with 1s duration
	_, err := client.UpdatePresence(context.Background(), testutil.AuthedRequest(t, userID, &v1.UpdatePresenceRequest{
		Status: v1.PresenceStatus_PRESENCE_STATUS_ONLINE,
	}))
	if err != nil {
		t.Fatalf("UpdatePresence: %v", err)
	}
	_, err = client.SetStatusOverride(context.Background(), testutil.AuthedRequest(t, userID, &v1.SetStatusOverrideRequest{
		Status:          v1.PresenceStatus_PRESENCE_STATUS_DND,
		DurationSeconds: 1,
	}))
	if err != nil {
		t.Fatalf("SetStatusOverride: %v", err)
	}

	// Wait for the override to expire (real time since expiry is checked via time.Now()).
	// Use 2s to account for unix second boundary crossing.
	time.Sleep(2 * time.Second)

	// GetMyPresence should auto-clear the expired override
	myResp, err := client.GetMyPresence(context.Background(), testutil.AuthedRequest(t, userID, &v1.GetMyPresenceRequest{}))
	if err != nil {
		t.Fatalf("GetMyPresence: %v", err)
	}
	if myResp.Msg.OverrideStatus != v1.PresenceStatus_PRESENCE_STATUS_UNSPECIFIED {
		t.Errorf("override_status = %v, want UNSPECIFIED (expired)", myResp.Msg.OverrideStatus)
	}
}

func TestOverrideAffectsBulkPresence(t *testing.T) {
	client, _, _ := setupPresenceTest(t)
	userA := models.NewID()
	userB := models.NewID()

	// Both users online
	for _, uid := range []string{userA, userB} {
		_, err := client.UpdatePresence(context.Background(), testutil.AuthedRequest(t, uid, &v1.UpdatePresenceRequest{
			Status: v1.PresenceStatus_PRESENCE_STATUS_ONLINE,
		}))
		if err != nil {
			t.Fatalf("UpdatePresence for %s: %v", uid, err)
		}
	}

	// userA sets invisible
	_, err := client.SetStatusOverride(context.Background(), testutil.AuthedRequest(t, userA, &v1.SetStatusOverrideRequest{
		Status: v1.PresenceStatus_PRESENCE_STATUS_INVISIBLE,
	}))
	if err != nil {
		t.Fatalf("SetStatusOverride: %v", err)
	}

	// userB queries bulk presence
	bulkResp, err := client.GetBulkPresence(context.Background(), testutil.AuthedRequest(t, userB, &v1.GetBulkPresenceRequest{
		UserIds: []string{userA, userB},
	}))
	if err != nil {
		t.Fatalf("GetBulkPresence: %v", err)
	}

	for _, p := range bulkResp.Msg.Presences {
		if p.UserId == userA {
			if p.Status != v1.PresenceStatus_PRESENCE_STATUS_OFFLINE {
				t.Errorf("invisible user seen by other in bulk = %v, want OFFLINE", p.Status)
			}
		} else if p.UserId == userB {
			if p.Status != v1.PresenceStatus_PRESENCE_STATUS_ONLINE {
				t.Errorf("userB status in bulk = %v, want ONLINE", p.Status)
			}
		}
	}
}

func TestUpdatePresenceWithOverrideBroadcastsEffective(t *testing.T) {
	client, _, nc := setupPresenceTest(t)
	userID := models.NewID()

	// Set online
	_, err := client.UpdatePresence(context.Background(), testutil.AuthedRequest(t, userID, &v1.UpdatePresenceRequest{
		Status: v1.PresenceStatus_PRESENCE_STATUS_ONLINE,
	}))
	if err != nil {
		t.Fatalf("UpdatePresence: %v", err)
	}

	// Set invisible override
	_, err = client.SetStatusOverride(context.Background(), testutil.AuthedRequest(t, userID, &v1.SetStatusOverrideRequest{
		Status: v1.PresenceStatus_PRESENCE_STATUS_INVISIBLE,
	}))
	if err != nil {
		t.Fatalf("SetStatusOverride: %v", err)
	}

	// Subscribe to presence updates
	received := make(chan *v1.GetPresenceResponse, 1)
	sub, err := nc.Subscribe(subjects.PresenceUpdate(userID), func(msg *nats.Msg) {
		var event v1.Event
		if err := proto.Unmarshal(msg.Data, &event); err != nil {
			return
		}
		if pu, ok := event.Payload.(*v1.Event_PresenceUpdate); ok {
			received <- pu.PresenceUpdate
		}
	})
	if err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	defer sub.Unsubscribe()

	// Simulate reconnect (UpdatePresence ONLINE) — should broadcast OFFLINE (effective)
	_, err = client.UpdatePresence(context.Background(), testutil.AuthedRequest(t, userID, &v1.UpdatePresenceRequest{
		Status: v1.PresenceStatus_PRESENCE_STATUS_ONLINE,
	}))
	if err != nil {
		t.Fatalf("UpdatePresence on reconnect: %v", err)
	}

	select {
	case pu := <-received:
		if pu.Status != v1.PresenceStatus_PRESENCE_STATUS_OFFLINE {
			t.Errorf("NATS broadcast status = %v, want OFFLINE (invisible override active)", pu.Status)
		}
	case <-time.After(2 * time.Second):
		t.Error("did not receive NATS presence update")
	}
}

func TestUpdatePresencePublishesNATS(t *testing.T) {
	client, _, nc := setupPresenceTest(t)
	userID := models.NewID()

	// Subscribe to presence updates
	received := make(chan struct{}, 1)
	sub, err := nc.Subscribe(subjects.PresenceUpdate(userID), func(_ *nats.Msg) {
		received <- struct{}{}
	})
	if err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	defer sub.Unsubscribe()

	_, err = client.UpdatePresence(context.Background(), testutil.AuthedRequest(t, userID, &v1.UpdatePresenceRequest{
		Status: v1.PresenceStatus_PRESENCE_STATUS_IDLE,
	}))
	if err != nil {
		t.Fatalf("UpdatePresence: %v", err)
	}

	select {
	case <-received:
		// success
	case <-time.After(2 * time.Second):
		t.Error("did not receive NATS presence update")
	}
}
