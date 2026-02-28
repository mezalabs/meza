package auth

import (
	"strings"
	"testing"
)

func TestEd25519TokenPairRoundTrip_Access(t *testing.T) {
	keys := generateTestKeys(t)
	userID := "user_01HQEXAMPLE"
	deviceID := "device_01HQEXAMPLE"

	access, _, err := GenerateTokenPairEd25519(userID, deviceID, keys, "https://home.example.com", false)
	if err != nil {
		t.Fatalf("GenerateTokenPairEd25519: %v", err)
	}

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
	if claims.IsRefresh {
		t.Error("access token should not be marked as refresh")
	}
}

func TestEd25519TokenPairRoundTrip_Refresh(t *testing.T) {
	keys := generateTestKeys(t)
	userID := "user_01HQEXAMPLE"
	deviceID := "device_01HQEXAMPLE"

	_, refresh, err := GenerateTokenPairEd25519(userID, deviceID, keys, "https://home.example.com", false)
	if err != nil {
		t.Fatalf("GenerateTokenPairEd25519: %v", err)
	}

	refreshClaims, err := ValidateTokenEd25519(refresh, keys.PublicKey)
	if err != nil {
		t.Fatalf("ValidateTokenEd25519(refresh): %v", err)
	}
	if refreshClaims.UserID != userID {
		t.Errorf("refresh UserID = %q, want %q", refreshClaims.UserID, userID)
	}
	if refreshClaims.DeviceID != deviceID {
		t.Errorf("refresh DeviceID = %q, want %q", refreshClaims.DeviceID, deviceID)
	}
	if !refreshClaims.IsRefresh {
		t.Error("refresh token should be marked as refresh")
	}
}

func TestValidateTokenEd25519Invalid(t *testing.T) {
	keys := generateTestKeys(t)
	_, err := ValidateTokenEd25519("not-a-token", keys.PublicKey)
	if err == nil {
		t.Error("expected error for invalid token")
	}
}

func TestFederationAssertionRejectedAsAccessToken(t *testing.T) {
	// Federation assertion tokens must be rejected when used as regular access tokens.
	// This is the key security property: a malicious remote instance that receives
	// an assertion cannot replay it against the home server's API endpoints.
	keys := generateTestKeys(t)

	token, err := GenerateFederationAssertion(
		"user_01HQEXAMPLE", "Test User", "https://example.com/avatar.png",
		keys, "https://home.example.com", "https://remote.example.com",
	)
	if err != nil {
		t.Fatalf("GenerateFederationAssertion: %v", err)
	}

	// Try to validate as a regular access token via Ed25519 path
	_, err = ValidateTokenEd25519(token, keys.PublicKey)
	if err == nil {
		t.Fatal("federation assertion should be rejected by ValidateTokenEd25519")
	}
	if !strings.Contains(err.Error(), "purpose") {
		t.Errorf("error should mention purpose claim, got: %v", err)
	}
}

func TestFederationAssertionAudienceMismatchExplicit(t *testing.T) {
	// An assertion scoped to instance A must be rejected by instance B.
	// Verifies the error message explicitly mentions audience mismatch.
	keys := generateTestKeys(t)

	token, err := GenerateFederationAssertion(
		"user_01HQEXAMPLE", "Test User", "",
		keys, "https://home.example.com", "https://instance-a.example.com",
	)
	if err != nil {
		t.Fatalf("GenerateFederationAssertion: %v", err)
	}

	// Validate with the wrong audience (instance B)
	_, err = ValidateFederationAssertion(token, keys.PublicKey, "https://instance-b.example.com")
	if err == nil {
		t.Fatal("assertion for instance A should be rejected by instance B")
	}
	if !strings.Contains(err.Error(), "audience mismatch") {
		t.Errorf("error should mention audience mismatch, got: %v", err)
	}
}

func TestFederationAssertionCannotBeUsedAsRegularToken(t *testing.T) {
	// A regular Ed25519 access token (no purpose claim) must be rejected
	// by ValidateFederationAssertion, and vice versa. This ensures the two
	// token types are completely incompatible.
	keys := generateTestKeys(t)

	access, _, err := GenerateTokenPairEd25519("user_01HQEXAMPLE", "device_01", keys, "https://home.example.com", false)
	if err != nil {
		t.Fatalf("GenerateTokenPairEd25519: %v", err)
	}

	_, err = ValidateFederationAssertion(access, keys.PublicKey, "https://remote.example.com")
	if err == nil {
		t.Fatal("regular access token should be rejected by ValidateFederationAssertion")
	}
	if !strings.Contains(err.Error(), "not a federation assertion") {
		t.Errorf("error should mention purpose, got: %v", err)
	}
}
