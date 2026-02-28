package auth

import (
	"context"
	"crypto/ed25519"
	"net/http"
	"strings"
)

// RequireHTTPAuth returns an HTTP middleware that validates a JWT from the
// Authorization header ("Bearer <token>") or a "token" query parameter. On
// success it injects the user ID and device ID into the request context
// (retrievable via UserIDFromContext / DeviceIDFromContext). On failure it
// responds with 401 Unauthorized.
func RequireHTTPAuth(ed25519PubKey ed25519.PublicKey) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			token := extractBearerToken(r)
			if token == "" {
				http.Error(w, "authentication required", http.StatusUnauthorized)
				return
			}

			claims, err := ValidateTokenEd25519(token, ed25519PubKey)
			if err != nil {
				http.Error(w, "invalid token", http.StatusUnauthorized)
				return
			}
			if claims.IsRefresh {
				http.Error(w, "refresh token cannot be used for authentication", http.StatusUnauthorized)
				return
			}

			ctx := r.Context()
			ctx = context.WithValue(ctx, userIDKey, claims.UserID)
			ctx = context.WithValue(ctx, deviceIDKey, claims.DeviceID)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// extractBearerToken returns the JWT from the Authorization header or a "token"
// query parameter (checked in that order). The query parameter is necessary for
// browser-initiated requests like <img src> and <video><source src> which
// cannot set custom headers.
func extractBearerToken(r *http.Request) string {
	if h := r.Header.Get("Authorization"); h != "" {
		return strings.TrimPrefix(h, "Bearer ")
	}
	if t := r.URL.Query().Get("token"); t != "" {
		return t
	}
	return ""
}
