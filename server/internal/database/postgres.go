package database

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// NewPostgresPool creates a new PostgreSQL connection pool with startup retry.
// Retries with exponential backoff for up to 2 minutes to handle cases where
// the database is still starting (e.g., after a server reboot).
func NewPostgresPool(ctx context.Context, connString string) (*pgxpool.Pool, error) {
	if connString == "" {
		return nil, fmt.Errorf("postgres connection string is empty")
	}

	config, err := pgxpool.ParseConfig(connString)
	if err != nil {
		return nil, fmt.Errorf("parsing postgres config: %w", err)
	}

	backoff := time.Second
	deadline := time.Now().Add(2 * time.Minute)

	for {
		pool, err := pgxpool.NewWithConfig(ctx, config)
		if err == nil {
			if pingErr := pool.Ping(ctx); pingErr == nil {
				return pool, nil
			} else {
				slog.Warn("postgres not ready, retrying", "err", pingErr, "backoff", backoff)
				pool.Close()

				if time.Now().After(deadline) {
					return nil, fmt.Errorf("postgres connection failed after 2m: %w", pingErr)
				}

				select {
				case <-ctx.Done():
					return nil, fmt.Errorf("postgres connection cancelled: %w", ctx.Err())
				case <-time.After(backoff):
				}

				backoff = min(backoff*2, 30*time.Second)
				continue
			}
		}

		if time.Now().After(deadline) {
			return nil, fmt.Errorf("postgres connection failed after 2m: %w", err)
		}

		slog.Warn("postgres not ready, retrying", "err", err, "backoff", backoff)

		select {
		case <-ctx.Done():
			return nil, fmt.Errorf("postgres connection cancelled: %w", ctx.Err())
		case <-time.After(backoff):
		}

		backoff = min(backoff*2, 30*time.Second)
	}
}
