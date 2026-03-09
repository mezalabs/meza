package auth

import "testing"

func TestDeviceNameFromUA(t *testing.T) {
	tests := []struct {
		ua   string
		want string
	}{
		{"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36", "Chrome on macOS"},
		{"Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0", "Firefox on Windows"},
		{"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15", "Safari on macOS"},
		{"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0", "Edge on Windows"},
		{"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36", "Chrome on Linux"},
		{"Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1", "Safari on iOS"},
		{"Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36", "Chrome on Android"},
		{"", ""},
		{"SomeUnknownBot/1.0", ""},
	}

	for _, tt := range tests {
		t.Run(tt.want, func(t *testing.T) {
			got := DeviceNameFromUA(tt.ua)
			if got != tt.want {
				t.Errorf("DeviceNameFromUA(%q) = %q, want %q", tt.ua, got, tt.want)
			}
		})
	}
}

func TestPlatformFromUA(t *testing.T) {
	tests := []struct {
		ua   string
		want string
	}{
		{"Mozilla/5.0 (Macintosh; Intel Mac OS X) Chrome/120 Electron/28.0.0", "electron"},
		{"Mozilla/5.0 (Macintosh; Intel Mac OS X) Chrome/120 Safari/537.36", "web"},
		{"", "web"},
	}
	for _, tt := range tests {
		if got := PlatformFromUA(tt.ua); got != tt.want {
			t.Errorf("PlatformFromUA(%q) = %q, want %q", tt.ua, got, tt.want)
		}
	}
}
