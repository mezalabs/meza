package embed

import (
	"net"
	"testing"
)

func TestIsBlockedIP(t *testing.T) {
	tests := []struct {
		ip      string
		blocked bool
	}{
		// Blocked ranges
		{"127.0.0.1", true},
		{"127.0.0.2", true},
		{"10.0.0.1", true},
		{"10.255.255.255", true},
		{"172.16.0.1", true},
		{"172.31.255.255", true},
		{"192.168.0.1", true},
		{"192.168.255.255", true},
		{"169.254.169.254", true}, // AWS metadata
		{"169.254.0.1", true},
		{"0.0.0.1", true},
		{"100.64.0.1", true},  // CGNAT
		{"100.127.255.255", true},
		{"::1", true},         // IPv6 loopback

		// Allowed ranges
		{"8.8.8.8", false},
		{"1.1.1.1", false},
		{"93.184.216.34", false}, // example.com
		{"172.15.255.255", false}, // just below 172.16.0.0/12
		{"172.32.0.0", false},     // just above 172.16.0.0/12
		{"100.63.255.255", false}, // just below CGNAT
		{"100.128.0.0", false},    // just above CGNAT
	}

	for _, tt := range tests {
		ip := net.ParseIP(tt.ip)
		if ip == nil {
			t.Fatalf("invalid IP: %s", tt.ip)
		}
		got := isBlockedIP(ip)
		if got != tt.blocked {
			t.Errorf("isBlockedIP(%s) = %v, want %v", tt.ip, got, tt.blocked)
		}
	}
}
