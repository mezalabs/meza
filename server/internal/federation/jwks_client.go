package federation

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"sync"
	"syscall"
	"time"

	"golang.org/x/sync/singleflight"
)

// privateIPNets contains CIDR ranges that must be blocked for SSRF protection.
// Includes RFC 1918 private, loopback, link-local, and IPv6 unique-local ranges.
var privateIPNets []*net.IPNet

func init() {
	for _, cidr := range []string{
		"10.0.0.0/8",      // RFC 1918 Class A private
		"172.16.0.0/12",   // RFC 1918 Class B private
		"192.168.0.0/16",  // RFC 1918 Class C private
		"127.0.0.0/8",     // IPv4 loopback
		"169.254.0.0/16",  // IPv4 link-local (cloud metadata)
		"0.0.0.0/8",       // Current network (RFC 1122)
		"100.64.0.0/10",   // Carrier-grade NAT (RFC 6598)
		"192.0.0.0/24",    // IANA special purpose
		"198.18.0.0/15",   // Benchmarking (RFC 2544)
		"::1/128",         // IPv6 loopback
		"fd00::/8",        // IPv6 unique-local (ULA)
		"fe80::/10",       // IPv6 link-local
	} {
		_, ipNet, err := net.ParseCIDR(cidr)
		if err != nil {
			panic(fmt.Sprintf("federation: invalid CIDR %q: %v", cidr, err))
		}
		privateIPNets = append(privateIPNets, ipNet)
	}
}

// IsPrivateIP reports whether ip falls within any blocked network range.
func IsPrivateIP(ip net.IP) bool {
	// Normalize IPv4-mapped IPv6 addresses (e.g. ::ffff:127.0.0.1) to IPv4
	// for consistent matching against the IPv4 CIDR blocklist.
	if v4 := ip.To4(); v4 != nil {
		ip = v4
	}
	for _, ipNet := range privateIPNets {
		if ipNet.Contains(ip) {
			return true
		}
	}
	return false
}

// ssrfSafeDialer returns a net.Dialer Control function that rejects connections
// to private, loopback, and link-local IP addresses. This prevents SSRF when
// the JWKS client fetches keys from URLs derived from untrusted JWT iss claims.
func ssrfSafeDialer() func(network, address string, c syscall.RawConn) error {
	return func(network, address string, c syscall.RawConn) error {
		host, _, err := net.SplitHostPort(address)
		if err != nil {
			return fmt.Errorf("JWKS SSRF check: invalid address %q: %w", address, err)
		}

		ip := net.ParseIP(host)
		if ip == nil {
			return fmt.Errorf("JWKS SSRF check: could not parse IP %q", host)
		}

		if IsPrivateIP(ip) {
			return fmt.Errorf("JWKS SSRF check: connection to private IP %s is forbidden", ip)
		}

		return nil
	}
}

const (
	jwksPath         = "/.well-known/jwks.json"
	jwksFetchTimeout = 10 * time.Second
	jwksRefreshEvery = 1 * time.Hour
	jwksMaxBody      = 256 * 1024 // 256 KB — more than enough for JWKS
)

// jwksResponse represents a JSON Web Key Set response (RFC 7517).
type jwksResponse struct {
	Keys []jwkKey `json:"keys"`
}

// jwkKey represents a single JSON Web Key.
type jwkKey struct {
	KTY string `json:"kty"`
	CRV string `json:"crv"`
	X   string `json:"x"`
	KID string `json:"kid"`
	Use string `json:"use"`
	Alg string `json:"alg"`
}

// CachedKey holds a resolved Ed25519 public key with its key ID.
type CachedKey struct {
	PublicKey ed25519.PublicKey
	KeyID     string
}

// JWKSClient fetches and caches JWKS from remote Meza instances.
// Uses singleflight to deduplicate concurrent fetches.
type JWKSClient struct {
	client *http.Client
	group  singleflight.Group

	mu   sync.RWMutex
	keys map[string][]CachedKey // issuer URL → cached keys
}

// NewJWKSClient creates a JWKS client hardened against SSRF and redirect-based
// attacks. The underlying transport resolves DNS and rejects connections to
// private, loopback, and link-local IP ranges before the TCP handshake.
func NewJWKSClient() *JWKSClient {
	return newJWKSClient(ssrfSafeDialer())
}

// newJWKSClient creates a JWKS client with an optional dialer Control function.
// Pass nil to skip SSRF IP filtering (used by tests that dial localhost).
func newJWKSClient(dialControl func(network, address string, c syscall.RawConn) error) *JWKSClient {
	dialer := &net.Dialer{
		Timeout:   5 * time.Second,
		KeepAlive: 30 * time.Second,
		Control:   dialControl,
	}

	transport := &http.Transport{
		DialContext:          dialer.DialContext,
		TLSHandshakeTimeout: 5 * time.Second,
		MaxIdleConns:         10,
		IdleConnTimeout:      60 * time.Second,
	}

	return &JWKSClient{
		client: &http.Client{
			Timeout:   jwksFetchTimeout,
			Transport: transport,
			CheckRedirect: func(req *http.Request, via []*http.Request) error {
				return fmt.Errorf("JWKS fetch: redirects are not allowed")
			},
		},
		keys: make(map[string][]CachedKey),
	}
}

// EagerLoad fetches JWKS for the origin at startup.
// Should be called before the server accepts federation requests.
func (c *JWKSClient) EagerLoad(ctx context.Context, originURL string) error {
	if _, err := c.fetchAndCache(ctx, originURL); err != nil {
		return fmt.Errorf("eager load JWKS for %s: %w", originURL, err)
	}
	slog.Info("JWKS loaded", "origin", originURL)
	return nil
}

// StartBackgroundRefresh starts a goroutine that refreshes the origin's JWKS periodically.
func (c *JWKSClient) StartBackgroundRefresh(ctx context.Context, originURL string) {
	go func() {
		ticker := time.NewTicker(jwksRefreshEvery)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if _, err := c.fetchAndCache(ctx, originURL); err != nil {
					slog.Warn("JWKS background refresh failed", "origin", originURL, "err", err)
				}
			}
		}
	}()
}

// GetKey returns the Ed25519 public key for the given issuer and key ID.
func (c *JWKSClient) GetKey(ctx context.Context, issuer, kid string) (ed25519.PublicKey, error) {
	// Check cache first
	c.mu.RLock()
	keys, ok := c.keys[issuer]
	c.mu.RUnlock()

	if ok {
		for _, k := range keys {
			if k.KeyID == kid {
				return k.PublicKey, nil
			}
		}
	}

	// Cache miss — fetch fresh JWKS via singleflight
	keys, err := c.fetchAndCache(ctx, issuer)
	if err != nil {
		return nil, err
	}

	for _, k := range keys {
		if k.KeyID == kid {
			return k.PublicKey, nil
		}
	}
	return nil, fmt.Errorf("key %q not found in JWKS for %s", kid, issuer)
}

func (c *JWKSClient) fetchAndCache(ctx context.Context, issuer string) ([]CachedKey, error) {
	result, err, _ := c.group.Do(issuer, func() (interface{}, error) {
		keys, err := c.fetchJWKS(ctx, issuer)
		if err != nil {
			return nil, err
		}
		c.mu.Lock()
		c.keys[issuer] = keys
		c.mu.Unlock()
		return keys, nil
	})
	if err != nil {
		return nil, err
	}
	return result.([]CachedKey), nil
}

func (c *JWKSClient) fetchJWKS(ctx context.Context, issuer string) ([]CachedKey, error) {
	url := issuer + jwksPath

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, fmt.Errorf("create request: %w", err)
	}

	resp, err := c.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("fetch JWKS from %s: %w", issuer, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("JWKS from %s returned status %d", issuer, resp.StatusCode)
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, jwksMaxBody))
	if err != nil {
		return nil, fmt.Errorf("read JWKS body: %w", err)
	}

	var jwks jwksResponse
	if err := json.Unmarshal(body, &jwks); err != nil {
		return nil, fmt.Errorf("decode JWKS: %w", err)
	}

	var keys []CachedKey
	for _, k := range jwks.Keys {
		// Only accept Ed25519 keys — reject RSA, EC, or unknown key types
		if k.KTY != "OKP" || k.CRV != "Ed25519" {
			slog.Warn("JWKS: skipping non-Ed25519 key", "issuer", issuer, "kty", k.KTY, "crv", k.CRV, "kid", k.KID)
			continue
		}

		pubBytes, err := base64.RawURLEncoding.DecodeString(k.X)
		if err != nil {
			slog.Warn("JWKS: invalid base64url in key", "issuer", issuer, "kid", k.KID, "err", err)
			continue
		}

		if len(pubBytes) != ed25519.PublicKeySize {
			slog.Warn("JWKS: invalid Ed25519 key size", "issuer", issuer, "kid", k.KID, "size", len(pubBytes))
			continue
		}

		keys = append(keys, CachedKey{
			PublicKey: ed25519.PublicKey(pubBytes),
			KeyID:     k.KID,
		})
	}

	if len(keys) == 0 {
		return nil, fmt.Errorf("no valid Ed25519 keys found in JWKS from %s", issuer)
	}

	return keys, nil
}
