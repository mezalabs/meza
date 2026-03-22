package auth

import (
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/pem"
	"fmt"
	"os"
	"sync"
	"time"

	"crypto/rand"

	"github.com/golang-jwt/jwt/v5"
)

const (
	accessTokenExpiry  = 1 * time.Hour
	refreshTokenExpiry = 30 * 24 * time.Hour
)

// Claims holds the structured JWT claims for a Meza token.
type Claims struct {
	UserID      string
	DeviceID    string
	IsRefresh   bool
	IsFederated bool      // true for federated shadow users (embedded in JWT)
	IsBot       bool      // true for bot token authentication (not JWT)
	Issuer      string    // Origin URL (e.g. "https://meza.chat")
	ExpiresAt   time.Time // Token expiry, used for verification cache TTL
}

// Ed25519Keys holds an Ed25519 keypair for JWT signing and verification.
type Ed25519Keys struct {
	PrivateKey ed25519.PrivateKey
	PublicKey  ed25519.PublicKey
	KeyID      string // kid for JWKS
}

// LoadEd25519Keys loads Ed25519 keys from environment config values.
// Tries privateKeyPEM first, then falls back to reading from filePath.
// Returns an error if neither is set (Ed25519 keys are required).
func LoadEd25519Keys(privateKeyPEM, filePath, keyID string) (*Ed25519Keys, error) {
	var pemData []byte

	switch {
	case privateKeyPEM != "":
		pemData = []byte(privateKeyPEM)
	case filePath != "":
		var err error
		pemData, err = os.ReadFile(filePath)
		if err != nil {
			return nil, fmt.Errorf("reading key file %s: %w", filePath, err)
		}
	default:
		return nil, fmt.Errorf("ed25519 key is required: set MEZA_JWT_PRIVATE_KEY or MEZA_JWT_KEY_FILE")
	}

	block, _ := pem.Decode(pemData)
	if block == nil {
		return nil, fmt.Errorf("failed to decode PEM block")
	}

	key, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("parsing private key: %w", err)
	}

	edKey, ok := key.(ed25519.PrivateKey)
	if !ok {
		return nil, fmt.Errorf("key is not Ed25519, got %T", key)
	}

	return &Ed25519Keys{
		PrivateKey: edKey,
		PublicKey:  edKey.Public().(ed25519.PublicKey),
		KeyID:      keyID,
	}, nil
}

// LoadEd25519PublicKey loads an Ed25519 public key from PEM for verification only.
// Tries publicKeyPEM first, then falls back to reading from filePath.
// Returns an error if neither is set (Ed25519 public key is required).
func LoadEd25519PublicKey(publicKeyPEM, filePath string) (ed25519.PublicKey, error) {
	var pemData []byte

	switch {
	case publicKeyPEM != "":
		pemData = []byte(publicKeyPEM)
	case filePath != "":
		var err error
		pemData, err = os.ReadFile(filePath)
		if err != nil {
			return nil, fmt.Errorf("reading public key file %s: %w", filePath, err)
		}
	default:
		return nil, fmt.Errorf("ed25519 public key is required: set MEZA_ED25519_PUBLIC_KEY or MEZA_ED25519_PUBLIC_KEY_FILE")
	}

	block, _ := pem.Decode(pemData)
	if block == nil {
		return nil, fmt.Errorf("failed to decode PEM block")
	}

	key, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("parsing public key: %w", err)
	}

	edKey, ok := key.(ed25519.PublicKey)
	if !ok {
		return nil, fmt.Errorf("key is not Ed25519, got %T", key)
	}

	return edKey, nil
}

// KeyFingerprint returns a hex-encoded SHA-256 fingerprint of the public key.
func (k *Ed25519Keys) KeyFingerprint() string {
	h := sha256.Sum256(k.PublicKey)
	return hex.EncodeToString(h[:8]) // Short fingerprint for logging
}

// GenerateTokenPairEd25519 creates an Ed25519 signed access + refresh JWT pair.
// Access tokens include profile claims for federation.
// When isFederated is true, the "is_federated" claim is embedded so services can
// reject federated users without a DB query.
func GenerateTokenPairEd25519(userID, deviceID string, keys *Ed25519Keys, issuer string, isFederated bool) (accessToken, refreshToken string, err error) {
	now := time.Now()

	accessClaims := jwt.MapClaims{
		"sub":       userID,
		"device_id": deviceID,
		"iss":       issuer,
		"jti":       randomID(),
		"iat":       now.Unix(),
		"exp":       now.Add(accessTokenExpiry).Unix(),
	}
	if isFederated {
		accessClaims["is_federated"] = true
	}
	access := jwt.NewWithClaims(jwt.SigningMethodEdDSA, accessClaims)
	access.Header["kid"] = keys.KeyID
	accessToken, err = access.SignedString(keys.PrivateKey)
	if err != nil {
		return "", "", fmt.Errorf("signing access token: %w", err)
	}

	refreshClaims := jwt.MapClaims{
		"sub":       userID,
		"device_id": deviceID,
		"iss":       issuer,
		"typ":       "refresh",
		"jti":       randomID(),
		"iat":       now.Unix(),
		"exp":       now.Add(refreshTokenExpiry).Unix(),
	}
	if isFederated {
		refreshClaims["is_federated"] = true
	}
	refresh := jwt.NewWithClaims(jwt.SigningMethodEdDSA, refreshClaims)
	refresh.Header["kid"] = keys.KeyID
	refreshToken, err = refresh.SignedString(keys.PrivateKey)
	if err != nil {
		return "", "", fmt.Errorf("signing refresh token: %w", err)
	}

	return accessToken, refreshToken, nil
}

// GenerateFederationAssertion creates a short-lived, audience-scoped JWT
// for federation join/refresh. Cannot be used for any origin API calls.
func GenerateFederationAssertion(userID, displayName, avatarURL string, keys *Ed25519Keys, issuer, audience string) (string, error) {
	now := time.Now()

	claims := jwt.MapClaims{
		"sub":          userID,
		"iss":          issuer,
		"aud":          audience,
		"purpose":      "federation",
		"display_name": displayName,
		"avatar_url":   avatarURL,
		"jti":          randomID(),
		"iat":          now.Unix(),
		"exp":          now.Add(60 * time.Second).Unix(),
	}
	token := jwt.NewWithClaims(jwt.SigningMethodEdDSA, claims)
	token.Header["kid"] = keys.KeyID
	return token.SignedString(keys.PrivateKey)
}

// ValidateTokenEd25519 validates a JWT using only Ed25519.
func ValidateTokenEd25519(tokenString string, publicKey ed25519.PublicKey) (*Claims, error) {
	token, err := jwt.Parse(tokenString, func(t *jwt.Token) (interface{}, error) {
		return publicKey, nil
	}, jwt.WithValidMethods([]string{"EdDSA"}))
	if err != nil {
		return nil, fmt.Errorf("parsing token: %w", err)
	}
	return extractClaims(token)
}

// FederationAssertionClaims holds claims from a federation assertion token.
type FederationAssertionClaims struct {
	UserID      string
	Issuer      string
	Audience    string
	DisplayName string
	AvatarURL   string
}

// ValidateFederationAssertion validates a federation assertion JWT.
// Checks purpose=federation, audience matches, and Ed25519 signature.
// Applies ±15s clock skew leeway for cross-instance clock drift.
func ValidateFederationAssertion(tokenString string, publicKey ed25519.PublicKey, expectedAudience string) (*FederationAssertionClaims, error) {
	token, err := jwt.Parse(tokenString, func(t *jwt.Token) (interface{}, error) {
		return publicKey, nil
	}, jwt.WithValidMethods([]string{"EdDSA"}), jwt.WithLeeway(15*time.Second))
	if err != nil {
		return nil, fmt.Errorf("parsing assertion: %w", err)
	}

	mapClaims, ok := token.Claims.(jwt.MapClaims)
	if !ok || !token.Valid {
		return nil, fmt.Errorf("invalid assertion")
	}

	purpose, _ := mapClaims["purpose"].(string)
	if purpose != "federation" {
		return nil, fmt.Errorf("not a federation assertion")
	}

	sub, ok := mapClaims["sub"].(string)
	if !ok || sub == "" {
		return nil, fmt.Errorf("missing sub claim")
	}

	iss, _ := mapClaims["iss"].(string)
	if iss == "" {
		return nil, fmt.Errorf("missing iss claim")
	}

	// Check audience
	aud, _ := mapClaims["aud"].(string)
	if aud != expectedAudience {
		return nil, fmt.Errorf("audience mismatch: got %q, want %q", aud, expectedAudience)
	}

	displayName, _ := mapClaims["display_name"].(string)
	avatarURL, _ := mapClaims["avatar_url"].(string)

	return &FederationAssertionClaims{
		UserID:      sub,
		Issuer:      iss,
		Audience:    aud,
		DisplayName: displayName,
		AvatarURL:   avatarURL,
	}, nil
}

func extractClaims(token *jwt.Token) (*Claims, error) {
	mapClaims, ok := token.Claims.(jwt.MapClaims)
	if !ok || !token.Valid {
		return nil, fmt.Errorf("invalid token")
	}

	// Reject federation assertion tokens — they must not be used as access tokens.
	if purpose, _ := mapClaims["purpose"].(string); purpose != "" {
		return nil, fmt.Errorf("token with purpose %q cannot be used as access token", purpose)
	}

	sub, ok := mapClaims["sub"].(string)
	if !ok || sub == "" {
		return nil, fmt.Errorf("missing sub claim")
	}

	deviceID, _ := mapClaims["device_id"].(string)
	typ, _ := mapClaims["typ"].(string)
	iss, _ := mapClaims["iss"].(string)
	isFederated, _ := mapClaims["is_federated"].(bool)

	// Extract expiry for cache TTL
	var expiresAt time.Time
	if exp, err := mapClaims.GetExpirationTime(); err == nil && exp != nil {
		expiresAt = exp.Time
	}

	return &Claims{
		UserID:      sub,
		DeviceID:    deviceID,
		IsRefresh:   typ == "refresh",
		IsFederated: isFederated,
		Issuer:      iss,
		ExpiresAt:   expiresAt,
	}, nil
}

// VerificationCache caches validated JWT claims by token hash to avoid
// repeated Ed25519 verification (~35us/op) on the hot path.
type VerificationCache struct {
	mu    sync.RWMutex
	cache map[string]*cachedClaims
}

type cachedClaims struct {
	claims    *Claims
	expiresAt time.Time
}

// NewVerificationCache creates a new JWT verification cache.
func NewVerificationCache() *VerificationCache {
	vc := &VerificationCache{
		cache: make(map[string]*cachedClaims),
	}
	go vc.cleanupLoop()
	return vc
}

func (vc *VerificationCache) tokenHash(token string) string {
	h := sha256.Sum256([]byte(token))
	return hex.EncodeToString(h[:])
}

// Get checks the cache for previously validated claims.
func (vc *VerificationCache) Get(tokenString string) (*Claims, bool) {
	hash := vc.tokenHash(tokenString)
	vc.mu.RLock()
	entry, ok := vc.cache[hash]
	vc.mu.RUnlock()
	if !ok || time.Now().After(entry.expiresAt) {
		return nil, false
	}
	return entry.claims, true
}

// verificationCacheMaxSize is the maximum number of entries in the verification cache.
// Beyond this limit, new entries are only inserted if an expired entry can be evicted.
const verificationCacheMaxSize = 50000

// Put stores validated claims in the cache.
func (vc *VerificationCache) Put(tokenString string, claims *Claims, expiresAt time.Time) {
	hash := vc.tokenHash(tokenString)
	vc.mu.Lock()
	if len(vc.cache) >= verificationCacheMaxSize {
		// Evict one expired entry to make room
		for k, v := range vc.cache {
			if time.Now().After(v.expiresAt) {
				delete(vc.cache, k)
				break
			}
		}
		// If still at capacity after evicting expired, skip this insert
		if len(vc.cache) >= verificationCacheMaxSize {
			vc.mu.Unlock()
			return
		}
	}
	vc.cache[hash] = &cachedClaims{claims: claims, expiresAt: expiresAt}
	vc.mu.Unlock()
}

// Invalidate removes a specific token from the cache (e.g., on revocation).
func (vc *VerificationCache) Invalidate(tokenString string) {
	hash := vc.tokenHash(tokenString)
	vc.mu.Lock()
	delete(vc.cache, hash)
	vc.mu.Unlock()
}

// InvalidateByUserID removes all cached entries for a given user ID.
// Used when a bot's tokens are revoked to ensure no stale cache hits.
func (vc *VerificationCache) InvalidateByUserID(userID string) {
	vc.mu.Lock()
	for k, entry := range vc.cache {
		if entry.claims != nil && entry.claims.UserID == userID {
			delete(vc.cache, k)
		}
	}
	vc.mu.Unlock()
}

func (vc *VerificationCache) cleanupLoop() {
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()
	for range ticker.C {
		now := time.Now()
		// Phase 1: collect expired keys under read lock
		vc.mu.RLock()
		var expired []string
		for k, v := range vc.cache {
			if now.After(v.expiresAt) {
				expired = append(expired, k)
			}
		}
		vc.mu.RUnlock()
		if len(expired) == 0 {
			continue
		}
		// Phase 2: delete under write lock
		vc.mu.Lock()
		for _, k := range expired {
			if entry, ok := vc.cache[k]; ok && now.After(entry.expiresAt) {
				delete(vc.cache, k)
			}
		}
		vc.mu.Unlock()
	}
}

func randomID() string {
	b := make([]byte, 16)
	rand.Read(b)
	return hex.EncodeToString(b)
}

