package permissions

import (
	"context"
	"fmt"
	"log/slog"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

const cacheTTL = 5 * time.Minute

// Cache provides a Redis-backed permission cache keyed by (userID, serverID, channelID).
type Cache struct {
	rdb *redis.Client
}

// NewCache creates a permission cache backed by the given Redis client.
// If rdb is nil, all operations are no-ops (cache disabled).
func NewCache(rdb *redis.Client) *Cache {
	return &Cache{rdb: rdb}
}

func cacheKey(userID, serverID, channelID string) string {
	if channelID == "" {
		channelID = "_"
	}
	return "perm:" + userID + ":" + serverID + ":" + channelID
}

// Get retrieves cached effective permissions. Returns (perms, true) on hit, (0, false) on miss.
func (c *Cache) Get(ctx context.Context, userID, serverID, channelID string) (int64, bool) {
	if c.rdb == nil {
		return 0, false
	}
	val, err := c.rdb.Get(ctx, cacheKey(userID, serverID, channelID)).Result()
	if err != nil {
		return 0, false
	}
	perms, err := strconv.ParseInt(val, 10, 64)
	if err != nil {
		return 0, false
	}
	return perms, true
}

// Set stores computed effective permissions in the cache.
func (c *Cache) Set(ctx context.Context, userID, serverID, channelID string, perms int64) {
	if c.rdb == nil {
		return
	}
	c.rdb.Set(ctx, cacheKey(userID, serverID, channelID), strconv.FormatInt(perms, 10), cacheTTL)
}

// InvalidateUser removes all cached permissions for a user in a server.
func (c *Cache) InvalidateUser(ctx context.Context, userID, serverID string) {
	if c.rdb == nil {
		return
	}
	c.deleteByPattern(ctx, fmt.Sprintf("perm:%s:%s:*", userID, serverID))
}

// InvalidateServer removes all cached permissions for an entire server.
func (c *Cache) InvalidateServer(ctx context.Context, serverID string) {
	if c.rdb == nil {
		return
	}
	c.deleteByPattern(ctx, fmt.Sprintf("perm:*:%s:*", serverID))
}

// InvalidateChannel removes all cached permissions for a specific channel.
func (c *Cache) InvalidateChannel(ctx context.Context, channelID string) {
	if c.rdb == nil {
		return
	}
	c.deleteByPattern(ctx, fmt.Sprintf("perm:*:*:%s", channelID))
}

// deleteByPattern scans and deletes keys matching the given pattern.
// Uses SCAN to avoid blocking Redis on large keyspaces.
func (c *Cache) deleteByPattern(ctx context.Context, pattern string) {
	var cursor uint64
	for {
		keys, next, err := c.rdb.Scan(ctx, cursor, pattern, 100).Result()
		if err != nil {
			slog.Error("permission cache SCAN failed", "err", err, "pattern", pattern)
			return
		}
		if len(keys) > 0 {
			if err := c.rdb.Del(ctx, keys...).Err(); err != nil {
				slog.Error("permission cache DEL failed", "err", err, "keys", len(keys))
			}
		}
		cursor = next
		if cursor == 0 {
			break
		}
	}
}
