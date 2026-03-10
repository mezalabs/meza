package auth

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/redis/go-redis/v9"
)

// TokenBlocklist provides a Redis-backed blocklist for revoked device tokens.
// When a device is revoked, its device ID is added to the blocklist with a TTL
// matching the access token lifetime, ensuring tokens for that device are
// rejected until they naturally expire.
type TokenBlocklist struct {
	client *redis.Client
}

// NewTokenBlocklist creates a blocklist backed by the given Redis client.
func NewTokenBlocklist(client *redis.Client) *TokenBlocklist {
	return &TokenBlocklist{client: client}
}

// BlockDevice marks a device ID as revoked. Tokens containing this device ID
// will be rejected by the auth interceptor until the TTL expires.
func (b *TokenBlocklist) BlockDevice(ctx context.Context, deviceID string, ttl time.Duration) error {
	key := fmt.Sprintf("blocked:device:%s", deviceID)
	return b.client.Set(ctx, key, "1", ttl).Err()
}

// IsDeviceBlocked checks whether a device ID has been revoked.
func (b *TokenBlocklist) IsDeviceBlocked(ctx context.Context, deviceID string) bool {
	key := fmt.Sprintf("blocked:device:%s", deviceID)
	val, err := b.client.Exists(ctx, key).Result()
	if err != nil {
		slog.Error("device blocklist check failed, failing open", "err", err, "device", deviceID)
		return false
	}
	return val > 0
}
