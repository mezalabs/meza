package main

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/mezalabs/meza/internal/models"
)

// stubUserStore is a minimal userResolver implementation for testing dmTitle.
type stubUserStore struct {
	user *models.User
	err  error
}

func (s *stubUserStore) GetUserDisplayName(_ context.Context, _ string) (string, string, error) {
	if s.err != nil {
		return "", "", s.err
	}
	if s.user == nil {
		return "", "", nil
	}
	return s.user.DisplayName, s.user.Username, nil
}

func TestPushTrigger_TagAndThrottleKeyType(t *testing.T) {
	cases := []struct {
		name             string
		t                pushTrigger
		wantTag          string
		wantThrottleType string
	}{
		{
			name:             "DM uses dm tag namespace",
			t:                pushTrigger{Kind: "dm", ChannelID: "c1"},
			wantTag:          "dm:c1",
			wantThrottleType: "dm",
		},
		{
			name:             "channel non-mention uses channel tag and message throttle",
			t:                pushTrigger{Kind: "message", ChannelID: "c2"},
			wantTag:          "channel:c2",
			wantThrottleType: "message",
		},
		{
			name:             "channel mention uses channel tag and mention throttle",
			t:                pushTrigger{Kind: "message", ChannelID: "c3", IsMention: true},
			wantTag:          "channel:c3",
			wantThrottleType: "mention",
		},
		{
			name:             "DM throttle does not flip on IsMention (no DM mentions today)",
			t:                pushTrigger{Kind: "dm", ChannelID: "c4", IsMention: true},
			wantTag:          "dm:c4",
			wantThrottleType: "dm",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.t.tag(); got != tc.wantTag {
				t.Errorf("tag() = %q, want %q", got, tc.wantTag)
			}
			if got := tc.t.throttleKeyType(); got != tc.wantThrottleType {
				t.Errorf("throttleKeyType() = %q, want %q", got, tc.wantThrottleType)
			}
		})
	}
}

// Per-field assertions live on the FCM message tests below — that's the
// wire contract clients consume. We retain only the JSON-shape test here
// to lock the omitempty behavior, which the FCM-data tests cannot cover
// (FCM data is a flat map, not the same JSON the web push body emits).

func TestBuildPushPayload_JSON_OmitsEmptyOptionalFields(t *testing.T) {
	// Confirms the omitempty tags work — old clients that don't know about
	// the new fields should not see noise like `"server_id":""` for DMs.
	device := &models.Device{ID: "d1", UserID: "u_recipient"}
	tr := pushTrigger{Kind: "dm", ChannelID: "c1", Title: "Alice", Body: "New message"}
	payload := buildPushPayload(device, tr)
	b, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	s := string(b)
	for _, banned := range []string{
		`"sender_id":""`,
		`"message_id":""`,
		`"server_id":""`,
		`"is_mention":""`,
		`"session_id":""`,
	} {
		if strings.Contains(s, banned) {
			t.Errorf("payload should omit empty optional fields, found %q in %s", banned, s)
		}
	}
}

func TestBuildFCMMessage_DM(t *testing.T) {
	device := &models.Device{ID: "d1", UserID: "u_recipient", Platform: "android", PushToken: "tok"}
	tr := pushTrigger{
		Kind:      "dm",
		ChannelID: "c1",
		SenderID:  "u_sender",
		MessageID: "m42",
		Title:     "Alice",
		Body:      "New message",
	}
	msg := buildFCMMessage(device, tr)

	wantData := map[string]string{
		"v":          "1",
		"type":       "dm",
		"channel_id": "c1",
		"user_id":    "u_recipient",
		"sender_id":  "u_sender",
		"message_id": "m42",
		"tag":        "dm:c1",
	}
	for k, v := range wantData {
		if got := msg.Data[k]; got != v {
			t.Errorf("Data[%q] = %q, want %q", k, got, v)
		}
	}
	// Negative: server_id should be omitted (DMs have none) and is_mention is "" (falsey).
	if _, ok := msg.Data["server_id"]; ok {
		t.Errorf("Data[server_id] should be absent for DM, got %q", msg.Data["server_id"])
	}
	if _, ok := msg.Data["is_mention"]; ok {
		t.Errorf("Data[is_mention] should be absent when IsMention=false, got %q", msg.Data["is_mention"])
	}
	if msg.Android == nil || msg.Android.Notification == nil || msg.Android.Notification.Title != "Alice" {
		t.Errorf("Android Title = %v, want Alice", msg.Android.Notification)
	}
	if msg.APNS == nil || msg.APNS.Headers["apns-collapse-id"] != "dm:c1" {
		t.Errorf("APNS collapse-id = %v, want dm:c1", msg.APNS.Headers)
	}
}

func TestBuildFCMMessage_ChannelMention(t *testing.T) {
	device := &models.Device{ID: "d1", UserID: "u_recipient", Platform: "ios", PushToken: "tok"}
	tr := pushTrigger{
		Kind:      "message",
		ChannelID: "c1",
		SenderID:  "u_sender",
		MessageID: "m42",
		ServerID:  "s1",
		IsMention: true,
		Title:     "New message",
		Body:      "You have a new message",
	}
	msg := buildFCMMessage(device, tr)

	if msg.Data["type"] != "message" {
		t.Errorf("Data[type] = %q, want message", msg.Data["type"])
	}
	if msg.Data["server_id"] != "s1" {
		t.Errorf("Data[server_id] = %q, want s1", msg.Data["server_id"])
	}
	if msg.Data["is_mention"] != "true" {
		t.Errorf("Data[is_mention] = %q, want true", msg.Data["is_mention"])
	}
	if msg.Data["tag"] != "channel:c1" {
		t.Errorf("Data[tag] = %q, want channel:c1", msg.Data["tag"])
	}
}

func TestDMTitle(t *testing.T) {
	cases := []struct {
		name  string
		store userResolver
		want  string
	}{
		{
			name:  "display name preferred when set",
			store: &stubUserStore{user: &models.User{DisplayName: "Alice", Username: "alice42"}},
			want:  "Alice",
		},
		{
			name:  "username fallback when display name empty",
			store: &stubUserStore{user: &models.User{Username: "alice42"}},
			want:  "alice42",
		},
		{
			name:  "generic fallback when both empty",
			store: &stubUserStore{user: &models.User{}},
			want:  "Direct message",
		},
		{
			name:  "lookup error falls back gracefully",
			store: &stubUserStore{err: errors.New("db down")},
			want:  "Direct message",
		},
		{
			name:  "nil store falls back",
			store: nil,
			want:  "Direct message",
		},
		{
			name:  "control chars stripped from display name",
			store: &stubUserStore{user: &models.User{DisplayName: "Alice\nNotification"}},
			want:  "Alice Notification",
		},
		{
			name:  "RTL override stripped",
			store: &stubUserStore{user: &models.User{DisplayName: "Alice‮ecila"}},
			want:  "Aliceecila",
		},
		{
			name:  "all-bidi falls through to username",
			store: &stubUserStore{user: &models.User{DisplayName: "‮‭", Username: "alice"}},
			want:  "alice",
		},
		{
			name:  "all-control falls through to fallback",
			store: &stubUserStore{user: &models.User{DisplayName: "\n\t\r"}},
			want:  "Direct message",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := dmTitle(context.Background(), tc.store, "u1"); got != tc.want {
				t.Errorf("dmTitle = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestSanitizeNotificationTitle(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		{"Alice", "Alice"},
		{"Alice\nWilson", "Alice Wilson"},
		{"  Alice  ", "Alice"},
		{"Alice‎Notification", "AliceNotification"}, // LRM stripped
		{"Alice‮ecila", "Aliceecila"},          // RTL override stripped
		{"\uFEFFAlice", "Alice"},                    // BOM stripped
		{"\n\t\r", ""},                              // all-control empty
		{"Alice⁦pwn⁩", "Alicepwn"},             // bidi isolate stripped
	}
	for _, tc := range cases {
		t.Run(tc.in, func(t *testing.T) {
			if got := sanitizeNotificationTitle(tc.in); got != tc.want {
				t.Errorf("sanitizeNotificationTitle(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

