//go:build integration

package security

import (
	"net/http"
	"testing"
)

// TestMissingHTTPSecurityHeaders audits all service endpoints for standard
// HTTP security headers.
//
// Severity: MEDIUM
// Finding: No Go service sets Content-Security-Policy, Strict-Transport-Security,
// X-Frame-Options, or X-Content-Type-Options headers. Only the media service
// sets X-Content-Type-Options: nosniff on media redirect responses.
//
// Remediation: Add a shared middleware in server/internal/ that sets security
// headers on all responses:
//   - Content-Security-Policy: default-src 'self'
//   - Strict-Transport-Security: max-age=31536000; includeSubDomains
//   - X-Frame-Options: DENY
//   - X-Content-Type-Options: nosniff
//   - Referrer-Policy: strict-origin-when-cross-origin
func TestMissingHTTPSecurityHeaders(t *testing.T) {
	services := []struct {
		name string
		url  string
	}{
		{"auth", authURL},
		{"chat", chatURL},
		{"presence", presenceURL},
		{"media", mediaURL},
		{"voice", voiceURL},
		{"notification", notificationURL},
		{"gateway", gatewayURL},
	}

	requiredHeaders := []string{
		"Content-Security-Policy",
		"Strict-Transport-Security",
		"X-Frame-Options",
		"X-Content-Type-Options",
	}

	for _, svc := range services {
		t.Run(svc.name, func(t *testing.T) {
			resp, err := http.Get(svc.url + "/health")
			if err != nil {
				t.Skipf("Service %s not reachable: %v", svc.name, err)
				return
			}
			defer resp.Body.Close()

			for _, header := range requiredHeaders {
				value := resp.Header.Get(header)
				if value == "" {
					t.Errorf("FINDING: %s service missing %s header", svc.name, header)
				}
			}
		})
	}
}

// TestJWKSWildcardCORS verifies the CORS configuration on the JWKS endpoint.
//
// Severity: LOW
// Finding: The JWKS endpoint (/.well-known/jwks.json) explicitly sets
// Access-Control-Allow-Origin: * which is correct for public key discovery
// but worth documenting.
//
// Remediation: This is expected behavior for JWKS endpoints. Document as
// an accepted risk rather than a vulnerability.
func TestJWKSWildcardCORS(t *testing.T) {
	req, err := http.NewRequest("GET", authURL+"/.well-known/jwks.json", nil)
	if err != nil {
		t.Fatalf("create request: %v", err)
	}
	req.Header.Set("Origin", "https://evil.example.com")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("JWKS request: %v", err)
	}
	defer resp.Body.Close()

	acao := resp.Header.Get("Access-Control-Allow-Origin")
	if acao == "*" {
		t.Log("FINDING (ACCEPTED): JWKS endpoint has Access-Control-Allow-Origin: * (expected for public key discovery)")
	} else if acao == "https://evil.example.com" {
		t.Log("FINDING: JWKS endpoint reflects arbitrary origin")
	} else {
		t.Logf("JWKS CORS: Access-Control-Allow-Origin: %s", acao)
	}

	// Verify JWKS endpoint returns valid JSON.
	if resp.StatusCode != http.StatusOK {
		t.Errorf("JWKS endpoint returned status %d (expected 200)", resp.StatusCode)
	}
	ct := resp.Header.Get("Content-Type")
	if ct != "application/json" && ct != "application/json; charset=utf-8" {
		t.Logf("JWKS Content-Type: %s (expected application/json)", ct)
	}
}
