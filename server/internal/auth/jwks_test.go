package auth

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestJWKSHandler(t *testing.T) {
	pub, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}

	handler := NewJWKSHandler(pub, "test-kid-1")
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodGet, "/.well-known/jwks.json", nil)
	handler(w, r)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}

	if ct := w.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("Content-Type = %q, want application/json", ct)
	}
	if cc := w.Header().Get("Cache-Control"); cc != "public, max-age=86400" {
		t.Errorf("Cache-Control = %q, want public, max-age=86400", cc)
	}
	if cors := w.Header().Get("Access-Control-Allow-Origin"); cors != "*" {
		t.Errorf("CORS = %q, want *", cors)
	}

	var jwks JWKSResponse
	if err := json.Unmarshal(w.Body.Bytes(), &jwks); err != nil {
		t.Fatalf("decode JWKS: %v", err)
	}

	if len(jwks.Keys) != 1 {
		t.Fatalf("keys count = %d, want 1", len(jwks.Keys))
	}

	key := jwks.Keys[0]
	if key.KTY != "OKP" {
		t.Errorf("kty = %q, want OKP", key.KTY)
	}
	if key.CRV != "Ed25519" {
		t.Errorf("crv = %q, want Ed25519", key.CRV)
	}
	if key.KID != "test-kid-1" {
		t.Errorf("kid = %q, want test-kid-1", key.KID)
	}
	if key.Use != "sig" {
		t.Errorf("use = %q, want sig", key.Use)
	}
	if key.Alg != "EdDSA" {
		t.Errorf("alg = %q, want EdDSA", key.Alg)
	}

	// Verify the key material can be decoded back
	decoded, err := base64.RawURLEncoding.DecodeString(key.X)
	if err != nil {
		t.Fatalf("decode x: %v", err)
	}
	if len(decoded) != ed25519.PublicKeySize {
		t.Errorf("decoded key size = %d, want %d", len(decoded), ed25519.PublicKeySize)
	}
}
