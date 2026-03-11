package ratelimit

import (
	"net/http"
	"testing"
)

func TestClientIP(t *testing.T) {
	tests := []struct {
		name       string
		remoteAddr string
		headers    map[string]string
		wantIP     string
	}{
		{
			name:       "CF-Connecting-IP takes priority",
			remoteAddr: "10.0.0.1:1234",
			headers: map[string]string{
				"CF-Connecting-IP": "203.0.113.50",
				"X-Forwarded-For":  "198.51.100.1, 10.0.0.1",
			},
			wantIP: "203.0.113.50",
		},
		{
			name:       "X-Forwarded-For used when no CF header",
			remoteAddr: "10.0.0.1:1234",
			headers: map[string]string{
				"X-Forwarded-For": "198.51.100.1, 10.0.0.1",
			},
			wantIP: "198.51.100.1",
		},
		{
			name:       "X-Forwarded-For single entry",
			remoteAddr: "10.0.0.1:1234",
			headers: map[string]string{
				"X-Forwarded-For": "198.51.100.1",
			},
			wantIP: "198.51.100.1",
		},
		{
			name:       "falls back to RemoteAddr",
			remoteAddr: "192.0.2.1:4321",
			headers:    nil,
			wantIP:     "192.0.2.1",
		},
		{
			name:       "RemoteAddr without port",
			remoteAddr: "192.0.2.1",
			headers:    nil,
			wantIP:     "192.0.2.1",
		},
		{
			name:       "CF-Connecting-IP with IPv4-mapped IPv6 normalises to IPv4",
			remoteAddr: "10.0.0.1:1234",
			headers: map[string]string{
				"CF-Connecting-IP": "::ffff:192.0.2.1",
			},
			wantIP: "192.0.2.1",
		},
		{
			name:       "X-Forwarded-For with IPv6 is normalised",
			remoteAddr: "10.0.0.1:1234",
			headers: map[string]string{
				"X-Forwarded-For": "2001:0db8:0000:0000:0000:0000:0000:0001, 10.0.0.1",
			},
			wantIP: "2001:db8::1",
		},
		{
			name:       "non-IP CF-Connecting-IP falls through to XFF",
			remoteAddr: "10.0.0.1:1234",
			headers: map[string]string{
				"CF-Connecting-IP": "not-an-ip",
				"X-Forwarded-For":  "198.51.100.5",
			},
			wantIP: "198.51.100.5",
		},
		{
			name:       "non-IP CF and XFF falls through to RemoteAddr",
			remoteAddr: "192.0.2.99:5678",
			headers: map[string]string{
				"CF-Connecting-IP": "garbage",
				"X-Forwarded-For":  "also-garbage",
			},
			wantIP: "192.0.2.99",
		},
		{
			name:       "RemoteAddr with bracketed IPv6 and port",
			remoteAddr: "[2001:db8::1]:8080",
			headers:    nil,
			wantIP:     "2001:db8::1",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := &http.Request{
				RemoteAddr: tt.remoteAddr,
				Header:     http.Header{},
			}
			for k, v := range tt.headers {
				r.Header.Set(k, v)
			}
			if got := clientIP(r); got != tt.wantIP {
				t.Errorf("clientIP() = %q, want %q", got, tt.wantIP)
			}
		})
	}
}
