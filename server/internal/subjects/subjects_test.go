package subjects

import "testing"

func TestSanitizeID(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		expected string
	}{
		{"clean ULID", "01ARZ3NDEKTSV4RRFFQ69G5FAV", "01ARZ3NDEKTSV4RRFFQ69G5FAV"},
		{"dot injection", "foo.bar", "foo_bar"},
		{"wildcard star", "foo*bar", "foo_bar"},
		{"wildcard gt", "foo>bar", "foo_bar"},
		{"space injection", "foo bar", "foo_bar"},
		{"multiple metachars", "a.b*c>d e", "a_b_c_d_e"},
		{"empty string", "", ""},
		{"only metachars", ".*>", "___"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := sanitizeID(tt.input)
			if got != tt.expected {
				t.Errorf("sanitizeID(%q) = %q, want %q", tt.input, got, tt.expected)
			}
		})
	}
}

func TestSubjectFunctionsSanitize(t *testing.T) {
	// An ID containing NATS metacharacters that would break subject routing
	// if not sanitized.
	malicious := "user.*>"

	tests := []struct {
		name   string
		fn     func(string) string
		prefix string
	}{
		{"DeliverChannel", DeliverChannel, "meza.deliver.channel."},
		{"PresenceHeartbeat", PresenceHeartbeat, "meza.presence.heartbeat."},
		{"PresenceUpdate", PresenceUpdate, "meza.presence.update."},
		{"ServerMember", ServerMember, "meza.server.member."},
		{"ServerChannel", ServerChannel, "meza.server.channel."},
		{"ServerRole", ServerRole, "meza.server.role."},
		{"ServerEmoji", ServerEmoji, "meza.server.emoji."},
		{"ServerSoundboard", ServerSoundboard, "meza.server.soundboard."},
		{"ServerChannelGroup", ServerChannelGroup, "meza.server.channelgroup."},
		{"UserReadState", UserReadState, "meza.user.readstate."},
		{"UserSubscription", UserSubscription, "meza.user.subscription."},
		{"UserRecovery", UserRecovery, "meza.user.recovery."},
		{"DeviceConnected", DeviceConnected, "meza.device.connected."},
		{"DeviceDisconnected", DeviceDisconnected, "meza.device.disconnected."},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := tt.fn(malicious)
			expected := tt.prefix + "user___"
			if result != expected {
				t.Errorf("%s(%q) = %q, want %q", tt.name, malicious, result, expected)
			}
		})
	}
}
