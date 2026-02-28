package federation

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func generateTestKey(t *testing.T) (ed25519.PublicKey, ed25519.PrivateKey) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return pub, priv
}

func serveJWKS(t *testing.T, pub ed25519.PublicKey, kid string) *httptest.Server {
	t.Helper()
	jwks := map[string]interface{}{
		"keys": []map[string]string{
			{
				"kty": "OKP",
				"crv": "Ed25519",
				"x":   base64.RawURLEncoding.EncodeToString(pub),
				"kid": kid,
				"use": "sig",
				"alg": "EdDSA",
			},
		},
	}
	body, _ := json.Marshal(jwks)

	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/.well-known/jwks.json" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write(body)
	}))
}

// newTestClient creates a JWKS client without SSRF filtering so that tests
// using httptest.NewServer (which binds to 127.0.0.1) can function normally.
func newTestClient() *JWKSClient {
	return newJWKSClient(nil)
}

func TestJWKSClientFetchAndGetKey(t *testing.T) {
	pub, _ := generateTestKey(t)
	srv := serveJWKS(t, pub, "key-1")
	defer srv.Close()

	client := newTestClient()
	ctx := context.Background()

	key, err := client.GetKey(ctx, srv.URL, "key-1")
	if err != nil {
		t.Fatalf("GetKey: %v", err)
	}

	if !key.Equal(pub) {
		t.Error("returned key does not match expected public key")
	}
}

func TestJWKSClientCachesKeys(t *testing.T) {
	pub, _ := generateTestKey(t)
	fetchCount := 0
	jwks := map[string]interface{}{
		"keys": []map[string]string{
			{
				"kty": "OKP",
				"crv": "Ed25519",
				"x":   base64.RawURLEncoding.EncodeToString(pub),
				"kid": "key-1",
				"use": "sig",
				"alg": "EdDSA",
			},
		},
	}
	body, _ := json.Marshal(jwks)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fetchCount++
		w.Header().Set("Content-Type", "application/json")
		w.Write(body)
	}))
	defer srv.Close()

	client := newTestClient()
	ctx := context.Background()

	// First call fetches
	_, err := client.GetKey(ctx, srv.URL, "key-1")
	if err != nil {
		t.Fatal(err)
	}
	if fetchCount != 1 {
		t.Errorf("fetchCount = %d, want 1", fetchCount)
	}

	// Second call should use cache
	_, err = client.GetKey(ctx, srv.URL, "key-1")
	if err != nil {
		t.Fatal(err)
	}
	if fetchCount != 1 {
		t.Errorf("fetchCount = %d, want 1 (cached)", fetchCount)
	}
}

func TestJWKSClientKeyNotFound(t *testing.T) {
	pub, _ := generateTestKey(t)
	srv := serveJWKS(t, pub, "key-1")
	defer srv.Close()

	client := newTestClient()
	ctx := context.Background()

	_, err := client.GetKey(ctx, srv.URL, "nonexistent-kid")
	if err == nil {
		t.Error("expected error for nonexistent key ID")
	}
}

func TestJWKSClientRejectsRedirects(t *testing.T) {
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "https://evil.com/.well-known/jwks.json", http.StatusFound)
	}))
	defer redirect.Close()

	client := newTestClient()
	ctx := context.Background()

	_, err := client.GetKey(ctx, redirect.URL, "any-kid")
	if err == nil {
		t.Error("expected error for redirect")
	}
}

func TestJWKSClientRejectsNonEd25519Keys(t *testing.T) {
	// Serve JWKS with RSA key type — should be rejected
	jwks := map[string]interface{}{
		"keys": []map[string]string{
			{
				"kty": "RSA",
				"n":   "fake-modulus",
				"e":   "AQAB",
				"kid": "rsa-key",
				"use": "sig",
				"alg": "RS256",
			},
		},
	}
	body, _ := json.Marshal(jwks)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write(body)
	}))
	defer srv.Close()

	client := newTestClient()
	ctx := context.Background()

	_, err := client.GetKey(ctx, srv.URL, "rsa-key")
	if err == nil {
		t.Error("expected error — should reject non-Ed25519 keys")
	}
}

func TestJWKSClientEagerLoad(t *testing.T) {
	pub, _ := generateTestKey(t)
	srv := serveJWKS(t, pub, "key-1")
	defer srv.Close()

	client := newTestClient()
	ctx := context.Background()

	err := client.EagerLoad(ctx, []string{srv.URL})
	if err != nil {
		t.Fatalf("EagerLoad: %v", err)
	}

	// Key should now be cached
	key, err := client.GetKey(ctx, srv.URL, "key-1")
	if err != nil {
		t.Fatalf("GetKey after EagerLoad: %v", err)
	}
	if !key.Equal(pub) {
		t.Error("cached key does not match")
	}
}

func TestJWKSClientServerDown(t *testing.T) {
	client := newTestClient()
	ctx := context.Background()

	_, err := client.GetKey(ctx, "http://localhost:1", "any-kid")
	if err == nil {
		t.Error("expected error for unreachable server")
	}
}

// --- SSRF protection tests ---

func TestIsPrivateIP(t *testing.T) {
	tests := []struct {
		ip      string
		private bool
	}{
		// IPv4 private ranges
		{"10.0.0.1", true},
		{"10.255.255.255", true},
		{"172.16.0.1", true},
		{"172.31.255.255", true},
		{"192.168.0.1", true},
		{"192.168.255.255", true},

		// Loopback
		{"127.0.0.1", true},
		{"127.255.255.255", true},

		// Link-local / cloud metadata
		{"169.254.169.254", true},
		{"169.254.0.1", true},

		// IPv6 loopback
		{"::1", true},

		// IPv6 unique-local
		{"fd00::1", true},
		{"fdff::1", true},

		// IPv6 link-local
		{"fe80::1", true},

		// IPv4-mapped IPv6 — must be normalized and blocked
		{"::ffff:127.0.0.1", true},
		{"::ffff:10.0.0.1", true},
		{"::ffff:169.254.169.254", true},
		{"::ffff:8.8.8.8", false},

		// Additional reserved ranges
		{"100.64.0.1", true},
		{"198.18.0.1", true},

		// Public IPs — must NOT be blocked
		{"8.8.8.8", false},
		{"1.1.1.1", false},
		{"93.184.216.34", false},
		{"172.15.255.255", false},  // just below 172.16.0.0/12
		{"172.32.0.0", false},      // just above 172.16.0.0/12
		{"192.167.255.255", false}, // just below 192.168.0.0/16

		// Public IPv6
		{"2607:f8b0:4004:800::200e", false},
	}

	for _, tt := range tests {
		ip := net.ParseIP(tt.ip)
		if ip == nil {
			t.Fatalf("failed to parse test IP: %s", tt.ip)
		}
		got := isPrivateIP(ip)
		if got != tt.private {
			t.Errorf("isPrivateIP(%s) = %v, want %v", tt.ip, got, tt.private)
		}
	}
}

func TestJWKSClientSSRFBlocksLoopback(t *testing.T) {
	// The production NewJWKSClient() must refuse to connect to 127.0.0.1
	// even if there is a real server there.
	pub, _ := generateTestKey(t)
	srv := serveJWKS(t, pub, "key-1")
	defer srv.Close()

	client := NewJWKSClient() // production client with SSRF protection
	ctx := context.Background()

	_, err := client.GetKey(ctx, srv.URL, "key-1")
	if err == nil {
		t.Fatal("expected SSRF error when connecting to loopback, got nil")
	}
	if !strings.Contains(err.Error(), "SSRF") && !strings.Contains(err.Error(), "private IP") {
		t.Errorf("error should mention SSRF or private IP, got: %v", err)
	}
}

func TestJWKSClientSSRFBlocksPrivateIPs(t *testing.T) {
	privateURLs := []string{
		"http://10.0.0.1:8080",
		"http://172.16.0.1:8080",
		"http://192.168.1.1:8080",
		"http://169.254.169.254",
	}

	client := NewJWKSClient()
	ctx := context.Background()

	for _, u := range privateURLs {
		_, err := client.GetKey(ctx, u, "any-kid")
		if err == nil {
			t.Errorf("expected error for private URL %s, got nil", u)
		}
	}
}
