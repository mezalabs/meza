package redis

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/redis/go-redis/v9"
)

// NewClient creates a new Redis client from a URL string with pool and
// timeout configuration. Retries with exponential backoff for up to 2 minutes
// to handle cases where Redis is still starting after a server reboot.
func NewClient(ctx context.Context, url string) (*redis.Client, error) {
	if url == "" {
		return nil, fmt.Errorf("redis URL is empty")
	}

	opts, err := redis.ParseURL(url)
	if err != nil {
		return nil, fmt.Errorf("parsing redis URL: %w", err)
	}

	opts.PoolSize = 10
	opts.ReadTimeout = 3 * time.Second
	opts.WriteTimeout = 3 * time.Second
	opts.DialTimeout = 5 * time.Second

	client := redis.NewClient(opts)

	backoff := time.Second
	deadline := time.Now().Add(2 * time.Minute)

	for {
		if pingErr := client.Ping(ctx).Err(); pingErr == nil {
			return client, nil
		}

		if time.Now().After(deadline) {
			client.Close()
			return nil, fmt.Errorf("redis connection failed after 2m: %w", client.Ping(ctx).Err())
		}

		slog.Warn("redis not ready, retrying", "err", client.Ping(ctx).Err(), "backoff", backoff)

		select {
		case <-ctx.Done():
			client.Close()
			return nil, fmt.Errorf("redis connection cancelled: %w", ctx.Err())
		case <-time.After(backoff):
		}

		backoff = min(backoff*2, 30*time.Second)
	}
}
