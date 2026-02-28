package auth

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"net/http"
)

// JWKSResponse represents a JSON Web Key Set response (RFC 7517).
type JWKSResponse struct {
	Keys []JWK `json:"keys"`
}

// JWK represents a single JSON Web Key.
type JWK struct {
	KTY string `json:"kty"` // Key type: "OKP" for Ed25519
	CRV string `json:"crv"` // Curve: "Ed25519"
	X   string `json:"x"`   // Base64url-encoded public key
	KID string `json:"kid"` // Key ID
	Use string `json:"use"` // Key use: "sig" for signing
	Alg string `json:"alg"` // Algorithm: "EdDSA"
}

// NewJWKSHandler creates an HTTP handler for the /.well-known/jwks.json endpoint.
// Returns the Ed25519 public key in JWKS format.
func NewJWKSHandler(publicKey ed25519.PublicKey, keyID string) http.HandlerFunc {
	jwks := JWKSResponse{
		Keys: []JWK{
			{
				KTY: "OKP",
				CRV: "Ed25519",
				X:   base64.RawURLEncoding.EncodeToString(publicKey),
				KID: keyID,
				Use: "sig",
				Alg: "EdDSA",
			},
		},
	}

	// Pre-marshal since the response is static
	body, _ := json.Marshal(jwks)

	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "public, max-age=86400")
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Write(body)
	}
}
