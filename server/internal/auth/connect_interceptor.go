package auth

import (
	"context"
	"crypto/ed25519"
	"errors"
	"log/slog"
	"strings"

	"connectrpc.com/connect"
)

// UserExistenceChecker checks whether a user exists in the database.
// Used by the auth interceptor to reject tokens for deleted/nonexistent users.
type UserExistenceChecker interface {
	UserExists(ctx context.Context, userID string) (bool, error)
}

// NewOptionalConnectInterceptor creates a unary interceptor that validates JWT
// tokens when present but does not reject unauthenticated requests. Useful for
// services that mix public and protected RPCs.
func NewOptionalConnectInterceptor(ed25519PubKey ed25519.PublicKey, opts ...InterceptorOption) connect.UnaryInterceptorFunc {
	cfg := &interceptorConfig{
		ed25519Key: ed25519PubKey,
	}
	for _, o := range opts {
		o(cfg)
	}

	return func(next connect.UnaryFunc) connect.UnaryFunc {
		return func(ctx context.Context, req connect.AnyRequest) (connect.AnyResponse, error) {
			if req.Spec().IsClient {
				return next(ctx, req)
			}
			header := req.Header().Get("Authorization")
			if header == "" {
				return next(ctx, req)
			}
			token := strings.TrimPrefix(header, "Bearer ")
			claims, err := validateWithConfig(token, cfg)
			if err != nil {
				return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("invalid token"))
			}
			if claims.IsRefresh {
				return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("refresh token cannot be used for authentication"))
			}
			// Check if the device has been revoked
			if cfg.tokenBlocklist != nil && claims.DeviceID != "" {
				if cfg.tokenBlocklist.IsDeviceBlocked(ctx, claims.DeviceID) {
					return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("device has been revoked"))
				}
			}
			// Check if federated user is blocked from this RPC
			if cfg.blockFederated && claims.IsFederated {
				return nil, connect.NewError(connect.CodePermissionDenied, errors.New("operation not available for federated users"))
			}
			ctx = context.WithValue(ctx, userIDKey, claims.UserID)
			ctx = context.WithValue(ctx, deviceIDKey, claims.DeviceID)
			return next(ctx, req)
		}
	}
}

// NewConnectInterceptor creates a unary interceptor that validates JWT tokens,
// optionally verifies the user exists in the database, and injects user ID and
// device ID into the context.
func NewConnectInterceptor(ed25519PubKey ed25519.PublicKey, opts ...InterceptorOption) connect.UnaryInterceptorFunc {
	cfg := &interceptorConfig{
		ed25519Key: ed25519PubKey,
	}
	for _, o := range opts {
		o(cfg)
	}

	return func(next connect.UnaryFunc) connect.UnaryFunc {
		return func(ctx context.Context, req connect.AnyRequest) (connect.AnyResponse, error) {
			if req.Spec().IsClient {
				return next(ctx, req)
			}

			isPublic := cfg.publicProcedures[req.Spec().Procedure]
			header := req.Header().Get("Authorization")

			if header == "" {
				if isPublic {
					return next(ctx, req)
				}
				return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing authorization header"))
			}
			token := strings.TrimPrefix(header, "Bearer ")
			claims, err := validateWithConfig(token, cfg)
			if err != nil {
				if isPublic {
					// Public procedure with invalid token — proceed unauthenticated.
					return next(ctx, req)
				}
				return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("invalid token"))
			}
			if claims.IsRefresh {
				return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("refresh token cannot be used for authentication"))
			}
			// Check if the device has been revoked
			if cfg.tokenBlocklist != nil && claims.DeviceID != "" {
				if cfg.tokenBlocklist.IsDeviceBlocked(ctx, claims.DeviceID) {
					return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("device has been revoked"))
				}
			}
			if cfg.userChecker != nil {
				exists, err := cfg.userChecker.UserExists(ctx, claims.UserID)
				if err != nil {
					slog.Error("checking user existence", "err", err, "user", claims.UserID)
					return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
				}
				if !exists {
					return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("user not found"))
				}
			}
			// Check if federated user is blocked from this RPC
			if cfg.blockFederated && claims.IsFederated {
				return nil, connect.NewError(connect.CodePermissionDenied, errors.New("operation not available for federated users"))
			}
			ctx = context.WithValue(ctx, userIDKey, claims.UserID)
			ctx = context.WithValue(ctx, deviceIDKey, claims.DeviceID)
			return next(ctx, req)
		}
	}
}

// validateWithConfig validates a token using the interceptor's configured keys.
// Uses verification cache if available, then Ed25519 validation.
func validateWithConfig(tokenString string, cfg *interceptorConfig) (*Claims, error) {
	// Check verification cache first
	if cfg.verificationCache != nil {
		if claims, ok := cfg.verificationCache.Get(tokenString); ok {
			return claims, nil
		}
	}

	claims, err := ValidateTokenEd25519(tokenString, cfg.ed25519Key)
	if err != nil {
		return nil, err
	}

	// Cache the validated claims
	if cfg.verificationCache != nil && !claims.ExpiresAt.IsZero() {
		cfg.verificationCache.Put(tokenString, claims, claims.ExpiresAt)
	}

	return claims, nil
}

type interceptorConfig struct {
	userChecker       UserExistenceChecker
	blockFederated    bool
	ed25519Key        ed25519.PublicKey
	verificationCache *VerificationCache
	publicProcedures  map[string]bool
	tokenBlocklist    *TokenBlocklist
}

// InterceptorOption configures the Connect auth interceptor.
type InterceptorOption func(*interceptorConfig)

// WithUserExistenceCheck enables user existence verification on every request.
func WithUserExistenceCheck(checker UserExistenceChecker) InterceptorOption {
	return func(cfg *interceptorConfig) {
		cfg.userChecker = checker
	}
}

// WithVerificationCache enables token verification caching to reduce Ed25519
// CPU overhead on the hot path.
func WithVerificationCache(cache *VerificationCache) InterceptorOption {
	return func(cfg *interceptorConfig) {
		cfg.verificationCache = cache
	}
}

// WithBlockFederated blocks federated users from calling this service's RPCs.
// Federation status is read from the JWT's "is_federated" claim — no DB query needed.
func WithBlockFederated() InterceptorOption {
	return func(cfg *interceptorConfig) {
		cfg.blockFederated = true
	}
}

// WithTokenBlocklist enables checking revoked device tokens against a Redis
// blocklist. Tokens for blocked devices are rejected with CodeUnauthenticated.
func WithTokenBlocklist(blocklist *TokenBlocklist) InterceptorOption {
	return func(cfg *interceptorConfig) {
		cfg.tokenBlocklist = blocklist
	}
}

// WithPublicProcedures marks specific RPC procedures as public, allowing them
// to be called without authentication even when using NewConnectInterceptor.
// If a valid token is present, the user context is still populated.
func WithPublicProcedures(procedures ...string) InterceptorOption {
	return func(cfg *interceptorConfig) {
		if cfg.publicProcedures == nil {
			cfg.publicProcedures = make(map[string]bool)
		}
		for _, p := range procedures {
			cfg.publicProcedures[p] = true
		}
	}
}
