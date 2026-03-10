package federation

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

func setupVerifierTest(t *testing.T) (*Verifier, ed25519.PrivateKey, string) {
	t.Helper()

	// Generate Ed25519 keypair (reuse helper from jwks_client_test.go)
	pub, priv := generateTestKey(t)

	// Create test JWKS server (reuse helper — serves on /.well-known/jwks.json)
	server := serveJWKS(t, pub, "test-key-1")
	t.Cleanup(server.Close)

	issuerURL := server.URL

	// Create JWKS client without SSRF filtering (for localhost test server)
	jwksClient := newTestClient()
	if err := jwksClient.EagerLoad(context.Background(), issuerURL); err != nil {
		t.Fatal(err)
	}

	instanceURL := "https://remote.example.com"
	verifier := NewVerifier(jwksClient, instanceURL, issuerURL)

	return verifier, priv, issuerURL
}

func makeTestAssertion(t *testing.T, priv ed25519.PrivateKey, claims jwt.MapClaims) string {
	t.Helper()
	token := jwt.NewWithClaims(jwt.SigningMethodEdDSA, claims)
	token.Header["kid"] = "test-key-1"
	signed, err := token.SignedString(priv)
	if err != nil {
		t.Fatal(err)
	}
	return signed
}

func TestVerifyAssertion_ValidToken(t *testing.T) {
	verifier, priv, issuerURL := setupVerifierTest(t)

	token := makeTestAssertion(t, priv, jwt.MapClaims{
		"sub":          "user123",
		"iss":          issuerURL,
		"aud":          "https://remote.example.com",
		"purpose":      "federation",
		"display_name": "Test User",
		"avatar_url":   "https://example.com/avatar.png",
		"jti":          "unique-id-1",
		"iat":          time.Now().Unix(),
		"exp":          time.Now().Add(60 * time.Second).Unix(),
	})

	claims, err := verifier.VerifyAssertion(context.Background(), token)
	if err != nil {
		t.Fatalf("expected no error, got: %v", err)
	}
	if claims.UserID != "user123" {
		t.Errorf("expected UserID=user123, got %s", claims.UserID)
	}
	if claims.Issuer != issuerURL {
		t.Errorf("expected Issuer=%s, got %s", issuerURL, claims.Issuer)
	}
	if claims.DisplayName != "Test User" {
		t.Errorf("expected DisplayName='Test User', got %s", claims.DisplayName)
	}
}

func TestVerifyAssertion_UntrustedIssuer(t *testing.T) {
	verifier, priv, _ := setupVerifierTest(t)

	token := makeTestAssertion(t, priv, jwt.MapClaims{
		"sub":     "user123",
		"iss":     "https://evil.example.com",
		"aud":     "https://remote.example.com",
		"purpose": "federation",
		"jti":     "unique-id-2",
		"iat":     time.Now().Unix(),
		"exp":     time.Now().Add(60 * time.Second).Unix(),
	})

	_, err := verifier.VerifyAssertion(context.Background(), token)
	if err == nil {
		t.Fatal("expected error for untrusted issuer")
	}
}

func TestVerifyAssertion_ExpiredToken(t *testing.T) {
	verifier, priv, issuerURL := setupVerifierTest(t)

	token := makeTestAssertion(t, priv, jwt.MapClaims{
		"sub":     "user123",
		"iss":     issuerURL,
		"aud":     "https://remote.example.com",
		"purpose": "federation",
		"jti":     "unique-id-3",
		"iat":     time.Now().Add(-120 * time.Second).Unix(),
		"exp":     time.Now().Add(-60 * time.Second).Unix(),
	})

	_, err := verifier.VerifyAssertion(context.Background(), token)
	if err == nil {
		t.Fatal("expected error for expired token")
	}
}

func TestVerifyAssertion_WrongAudience(t *testing.T) {
	verifier, priv, issuerURL := setupVerifierTest(t)

	token := makeTestAssertion(t, priv, jwt.MapClaims{
		"sub":     "user123",
		"iss":     issuerURL,
		"aud":     "https://wrong-instance.example.com",
		"purpose": "federation",
		"jti":     "unique-id-4",
		"iat":     time.Now().Unix(),
		"exp":     time.Now().Add(60 * time.Second).Unix(),
	})

	_, err := verifier.VerifyAssertion(context.Background(), token)
	if err == nil {
		t.Fatal("expected error for wrong audience")
	}
}

func TestVerifyAssertion_MissingKid(t *testing.T) {
	verifier, priv, issuerURL := setupVerifierTest(t)

	claims := jwt.MapClaims{
		"sub":     "user123",
		"iss":     issuerURL,
		"aud":     "https://remote.example.com",
		"purpose": "federation",
		"jti":     "unique-id-5",
		"iat":     time.Now().Unix(),
		"exp":     time.Now().Add(60 * time.Second).Unix(),
	}
	token := jwt.NewWithClaims(jwt.SigningMethodEdDSA, claims)
	// Deliberately DON'T set kid
	signed, err := token.SignedString(priv)
	if err != nil {
		t.Fatal(err)
	}

	_, err = verifier.VerifyAssertion(context.Background(), signed)
	if err == nil {
		t.Fatal("expected error for missing kid")
	}
}

func TestVerifyAssertion_WrongPurpose(t *testing.T) {
	verifier, priv, issuerURL := setupVerifierTest(t)

	token := makeTestAssertion(t, priv, jwt.MapClaims{
		"sub":     "user123",
		"iss":     issuerURL,
		"aud":     "https://remote.example.com",
		"purpose": "not_federation",
		"jti":     "unique-id-6",
		"iat":     time.Now().Unix(),
		"exp":     time.Now().Add(60 * time.Second).Unix(),
	})

	_, err := verifier.VerifyAssertion(context.Background(), token)
	if err == nil {
		t.Fatal("expected error for wrong purpose")
	}
}

func TestVerifyAssertion_WrongSigningKey(t *testing.T) {
	verifier, _, issuerURL := setupVerifierTest(t)

	// Generate a DIFFERENT keypair
	_, otherPriv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}

	token := makeTestAssertion(t, otherPriv, jwt.MapClaims{
		"sub":     "user123",
		"iss":     issuerURL,
		"aud":     "https://remote.example.com",
		"purpose": "federation",
		"jti":     "unique-id-7",
		"iat":     time.Now().Unix(),
		"exp":     time.Now().Add(60 * time.Second).Unix(),
	})

	_, err = verifier.VerifyAssertion(context.Background(), token)
	if err == nil {
		t.Fatal("expected error for wrong signing key")
	}
}
