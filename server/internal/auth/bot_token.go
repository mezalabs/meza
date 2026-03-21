package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"strings"
	"time"

	"github.com/mezalabs/meza/internal/models"
)

const (
	// BotTokenPrefix is the prefix for all bot API tokens.
	BotTokenPrefix = "meza_bot_"

	// botTokenRandomBytes is the number of random bytes in a bot token.
	botTokenRandomBytes = 32

	// botTokenCacheTTL is how long bot token claims are cached.
	botTokenCacheTTL = 5 * time.Minute
)

// BotTokenLookup is the interface for looking up bot users by token hash.
type BotTokenLookup interface {
	GetBotByTokenHash(ctx context.Context, tokenHash []byte) (*models.User, error)
	UpdateBotTokenLastUsed(ctx context.Context, tokenHash []byte) error
}

// TokenAuthenticator validates opaque bot tokens by looking up their SHA-256
// hash in the database.
type TokenAuthenticator struct {
	store BotTokenLookup
	cache *VerificationCache
}

// NewTokenAuthenticator creates a new bot token authenticator.
func NewTokenAuthenticator(store BotTokenLookup, cache *VerificationCache) *TokenAuthenticator {
	return &TokenAuthenticator{store: store, cache: cache}
}

// IsBotToken returns true if the token has the bot token prefix.
func IsBotToken(token string) bool {
	return strings.HasPrefix(token, BotTokenPrefix)
}

// Authenticate validates a bot token and returns Claims.
// The token format is: meza_bot_<base64url(32 random bytes)>
func (a *TokenAuthenticator) Authenticate(ctx context.Context, token string) (*Claims, error) {
	// Check cache first
	if a.cache != nil {
		if claims, ok := a.cache.Get(token); ok {
			return claims, nil
		}
	}

	// Strip prefix and hash
	raw := strings.TrimPrefix(token, BotTokenPrefix)
	if raw == "" {
		return nil, fmt.Errorf("empty bot token")
	}

	hash := HashBotToken(raw)

	user, err := a.store.GetBotByTokenHash(ctx, hash)
	if err != nil {
		return nil, fmt.Errorf("invalid bot token")
	}

	claims := &Claims{
		UserID:    user.ID,
		DeviceID:  "bot",
		IsBot:     true,
		ExpiresAt: time.Now().Add(botTokenCacheTTL),
	}

	// Cache the result
	if a.cache != nil {
		a.cache.Put(token, claims, claims.ExpiresAt)
	}

	// Update last_used_at asynchronously (fire-and-forget)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = a.store.UpdateBotTokenLastUsed(ctx, hash)
	}()

	return claims, nil
}

// GenerateBotToken creates a new random bot token and returns the plaintext
// token (with prefix) and its SHA-256 hash for storage.
func GenerateBotToken() (token string, hash []byte, err error) {
	raw := make([]byte, botTokenRandomBytes)
	if _, err := rand.Read(raw); err != nil {
		return "", nil, fmt.Errorf("generate random bytes: %w", err)
	}

	encoded := base64.RawURLEncoding.EncodeToString(raw)
	plaintext := BotTokenPrefix + encoded
	tokenHash := HashBotToken(encoded)

	return plaintext, tokenHash, nil
}

// HashBotToken returns the SHA-256 hash of the raw token (without prefix).
func HashBotToken(raw string) []byte {
	h := sha256.Sum256([]byte(raw))
	return h[:]
}
