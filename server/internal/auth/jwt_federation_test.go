package auth

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/pem"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

func generateTestKeys(t *testing.T) *Ed25519Keys {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return &Ed25519Keys{
		PrivateKey: priv,
		PublicKey:  pub,
		KeyID:      "test-key-1",
	}
}

func TestEd25519TokenPairRoundTrip(t *testing.T) {
	keys := generateTestKeys(t)
	userID := "user_01HQEXAMPLE"
	deviceID := "device_01HQEXAMPLE"
	issuer := "https://home.example.com"

	access, refresh, err := GenerateTokenPairEd25519(userID, deviceID, keys, issuer, false)
	if err != nil {
		t.Fatalf("GenerateTokenPairEd25519: %v", err)
	}

	// Validate access token
	claims, err := ValidateTokenEd25519(access, keys.PublicKey)
	if err != nil {
		t.Fatalf("ValidateTokenEd25519(access): %v", err)
	}
	if claims.UserID != userID {
		t.Errorf("access UserID = %q, want %q", claims.UserID, userID)
	}
	if claims.DeviceID != deviceID {
		t.Errorf("access DeviceID = %q, want %q", claims.DeviceID, deviceID)
	}
	if claims.Issuer != issuer {
		t.Errorf("access Issuer = %q, want %q", claims.Issuer, issuer)
	}
	if claims.IsRefresh {
		t.Error("access token should not be marked as refresh")
	}

	// Validate refresh token
	refreshClaims, err := ValidateTokenEd25519(refresh, keys.PublicKey)
	if err != nil {
		t.Fatalf("ValidateTokenEd25519(refresh): %v", err)
	}
	if refreshClaims.UserID != userID {
		t.Errorf("refresh UserID = %q, want %q", refreshClaims.UserID, userID)
	}
	if !refreshClaims.IsRefresh {
		t.Error("refresh token should be marked as refresh")
	}
}

// TestAlgorithmConfusionPrevention verifies CVE-2016-5431 mitigation:
// An attacker signs an alg:HS256 token using the Ed25519 public key bytes
// (which are publicly available via JWKS). This must be rejected.
func TestAlgorithmConfusionPrevention(t *testing.T) {
	keys := generateTestKeys(t)

	// Attacker signs HS256 token using the public key bytes as the HMAC secret
	now := time.Now()
	attackerClaims := jwt.MapClaims{
		"sub":       "attacker",
		"device_id": "evil-device",
		"jti":       "evil-jti",
		"iat":       now.Unix(),
		"exp":       now.Add(1 * time.Hour).Unix(),
	}
	attackerToken := jwt.NewWithClaims(jwt.SigningMethodHS256, attackerClaims)
	// Sign with the Ed25519 PUBLIC key bytes as HMAC secret
	tokenString, err := attackerToken.SignedString([]byte(keys.PublicKey))
	if err != nil {
		t.Fatalf("signing attacker token: %v", err)
	}

	// Ed25519-only validation must reject HS256 token
	_, err = ValidateTokenEd25519(tokenString, keys.PublicKey)
	if err == nil {
		t.Fatal("ValidateTokenEd25519 accepted HS256 token")
	}
}

func TestFederationAssertionRoundTrip(t *testing.T) {
	keys := generateTestKeys(t)
	issuer := "https://home.example.com"
	audience := "https://coolgroup.org"

	assertion, err := GenerateFederationAssertion("user1", "Alice", "https://cdn/avatar.png", keys, issuer, audience)
	if err != nil {
		t.Fatalf("GenerateFederationAssertion: %v", err)
	}

	claims, err := ValidateFederationAssertion(assertion, keys.PublicKey, audience)
	if err != nil {
		t.Fatalf("ValidateFederationAssertion: %v", err)
	}

	if claims.UserID != "user1" {
		t.Errorf("UserID = %q, want %q", claims.UserID, "user1")
	}
	if claims.Issuer != issuer {
		t.Errorf("Issuer = %q, want %q", claims.Issuer, issuer)
	}
	if claims.Audience != audience {
		t.Errorf("Audience = %q, want %q", claims.Audience, audience)
	}
	if claims.DisplayName != "Alice" {
		t.Errorf("DisplayName = %q, want %q", claims.DisplayName, "Alice")
	}
	if claims.AvatarURL != "https://cdn/avatar.png" {
		t.Errorf("AvatarURL = %q, want %q", claims.AvatarURL, "https://cdn/avatar.png")
	}
}

func TestFederationAssertionWrongAudience(t *testing.T) {
	keys := generateTestKeys(t)

	assertion, err := GenerateFederationAssertion("user1", "Alice", "", keys, "https://home.example.com", "https://coolgroup.org")
	if err != nil {
		t.Fatal(err)
	}

	// Try validating with wrong audience
	_, err = ValidateFederationAssertion(assertion, keys.PublicKey, "https://evil.com")
	if err == nil {
		t.Fatal("should reject assertion with wrong audience")
	}
}

func TestFederationAssertionWrongKey(t *testing.T) {
	keys := generateTestKeys(t)
	otherKeys := generateTestKeys(t)

	assertion, err := GenerateFederationAssertion("user1", "Alice", "", keys, "https://home.example.com", "https://target.com")
	if err != nil {
		t.Fatal(err)
	}

	// Validate with a different key
	_, err = ValidateFederationAssertion(assertion, otherKeys.PublicKey, "https://target.com")
	if err == nil {
		t.Fatal("should reject assertion signed with different key")
	}
}

func TestEd25519TokenWrongKey(t *testing.T) {
	keys := generateTestKeys(t)
	otherKeys := generateTestKeys(t)

	access, _, err := GenerateTokenPairEd25519("user1", "device1", keys, "https://home.example.com", false)
	if err != nil {
		t.Fatal(err)
	}

	_, err = ValidateTokenEd25519(access, otherKeys.PublicKey)
	if err == nil {
		t.Error("should reject token signed with different key")
	}
}

func TestVerificationCache(t *testing.T) {
	cache := NewVerificationCache()

	claims := &Claims{UserID: "user1", DeviceID: "device1"}
	token := "test-token-string"
	expiry := time.Now().Add(1 * time.Hour)

	// Cache miss
	_, ok := cache.Get(token)
	if ok {
		t.Error("expected cache miss")
	}

	// Put and get
	cache.Put(token, claims, expiry)
	got, ok := cache.Get(token)
	if !ok {
		t.Fatal("expected cache hit")
	}
	if got.UserID != "user1" {
		t.Errorf("cached UserID = %q, want %q", got.UserID, "user1")
	}

	// Expired entry
	expiredToken := "expired-token"
	cache.Put(expiredToken, claims, time.Now().Add(-1*time.Second))
	_, ok = cache.Get(expiredToken)
	if ok {
		t.Error("expected cache miss for expired entry")
	}
}

func TestLoadEd25519KeysFromPEM(t *testing.T) {
	// Generate a keypair and encode as PEM
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}

	pkcs8, err := x509.MarshalPKCS8PrivateKey(priv)
	if err != nil {
		t.Fatal(err)
	}

	pemData := pem.EncodeToMemory(&pem.Block{
		Type:  "PRIVATE KEY",
		Bytes: pkcs8,
	})

	keys, err := LoadEd25519Keys(string(pemData), "", "test-kid")
	if err != nil {
		t.Fatalf("LoadEd25519Keys: %v", err)
	}
	if keys == nil {
		t.Fatal("expected keys, got nil")
	}
	if keys.KeyID != "test-kid" {
		t.Errorf("KeyID = %q, want %q", keys.KeyID, "test-kid")
	}
	if len(keys.PublicKey) != ed25519.PublicKeySize {
		t.Errorf("public key size = %d, want %d", len(keys.PublicKey), ed25519.PublicKeySize)
	}

	// Verify the loaded keys can sign and verify
	access, _, err := GenerateTokenPairEd25519("user1", "device1", keys, "https://home.example.com", false)
	if err != nil {
		t.Fatalf("sign with loaded keys: %v", err)
	}
	_, err = ValidateTokenEd25519(access, keys.PublicKey)
	if err != nil {
		t.Fatalf("verify with loaded keys: %v", err)
	}
}

func TestLoadEd25519KeysErrorWhenEmpty(t *testing.T) {
	_, err := LoadEd25519Keys("", "", "")
	if err == nil {
		t.Fatal("expected error for empty config")
	}
}

func TestLoadEd25519KeysInvalidPEM(t *testing.T) {
	_, err := LoadEd25519Keys("not-valid-pem", "", "kid")
	if err == nil {
		t.Error("expected error for invalid PEM")
	}
}

func TestParseTrustedHomeServers(t *testing.T) {
	tests := []struct {
		input string
		want  []string
	}{
		{"", nil},
		{"https://home.example.com", []string{"https://home.example.com"}},
		{"https://a.com, https://b.com", []string{"https://a.com", "https://b.com"}},
		{"  https://a.com , https://b.com , ", []string{"https://a.com", "https://b.com"}},
	}

	for _, tt := range tests {
		got := ParseTrustedHomeServers(tt.input)
		if len(got) != len(tt.want) {
			t.Errorf("ParseTrustedHomeServers(%q) = %v, want %v", tt.input, got, tt.want)
			continue
		}
		for i := range got {
			if got[i] != tt.want[i] {
				t.Errorf("ParseTrustedHomeServers(%q)[%d] = %q, want %q", tt.input, i, got[i], tt.want[i])
			}
		}
	}
}

func TestKeyFingerprint(t *testing.T) {
	keys := generateTestKeys(t)
	fp := keys.KeyFingerprint()
	if len(fp) != 16 { // 8 bytes * 2 hex chars
		t.Errorf("fingerprint length = %d, want 16", len(fp))
	}
}
