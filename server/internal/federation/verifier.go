package federation

import (
	"context"
	"fmt"

	"github.com/golang-jwt/jwt/v5"

	"github.com/mezalabs/meza/internal/auth"
)

// Verifier validates federation assertion JWTs by fetching the signing key
// from the issuer's JWKS endpoint.
type Verifier struct {
	jwks        *JWKSClient
	instanceURL string // This instance's public URL (expected audience)
	trusted     map[string]bool
}

// NewVerifier creates a federation assertion verifier.
func NewVerifier(jwks *JWKSClient, instanceURL string, trustedServers []string) *Verifier {
	trusted := make(map[string]bool, len(trustedServers))
	for _, s := range trustedServers {
		trusted[s] = true
	}
	return &Verifier{
		jwks:        jwks,
		instanceURL: instanceURL,
		trusted:     trusted,
	}
}

// VerifyAssertion validates a federation assertion JWT. It resolves the signing
// key from the issuer's JWKS endpoint, verifies the Ed25519 signature, and
// checks issuer trust, audience, purpose, and expiry.
func (v *Verifier) VerifyAssertion(ctx context.Context, tokenString string) (*auth.FederationAssertionClaims, error) {
	// Parse unverified to extract kid and iss for key lookup
	parser := jwt.NewParser(jwt.WithoutClaimsValidation())
	unverified, _, err := parser.ParseUnverified(tokenString, jwt.MapClaims{})
	if err != nil {
		return nil, fmt.Errorf("parse assertion header: %w", err)
	}

	kid, _ := unverified.Header["kid"].(string)
	if kid == "" {
		return nil, fmt.Errorf("missing kid in assertion header")
	}

	mapClaims, ok := unverified.Claims.(jwt.MapClaims)
	if !ok {
		return nil, fmt.Errorf("invalid assertion claims")
	}

	iss, _ := mapClaims["iss"].(string)
	if iss == "" {
		return nil, fmt.Errorf("missing iss claim in assertion")
	}

	// Check issuer is trusted
	if !v.trusted[iss] {
		return nil, fmt.Errorf("untrusted issuer: %s", iss)
	}

	// Fetch public key from issuer's JWKS
	pubKey, err := v.jwks.GetKey(ctx, iss, kid)
	if err != nil {
		return nil, fmt.Errorf("resolve signing key: %w", err)
	}

	// Validate with the resolved key
	return auth.ValidateFederationAssertion(tokenString, pubKey, v.instanceURL)
}
