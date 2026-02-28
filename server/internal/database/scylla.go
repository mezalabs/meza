package database

import (
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/gocql/gocql"
)

// NewScyllaSession creates a new ScyllaDB session with startup retry.
// Retries with exponential backoff for up to 2 minutes to handle cases where
// ScyllaDB is still starting (typically takes 60-120s after a cold start).
// The keyspace parameter is optional; pass empty string to connect without a keyspace.
func NewScyllaSession(hosts string, keyspace string) (*gocql.Session, error) {
	if hosts == "" {
		return nil, fmt.Errorf("scylla hosts string is empty")
	}

	hostList := strings.Split(hosts, ",")

	backoff := time.Second
	deadline := time.Now().Add(2 * time.Minute)

	for {
		cluster := gocql.NewCluster(hostList...)

		if keyspace != "" {
			cluster.Keyspace = keyspace
		}

		cluster.Consistency = gocql.One
		cluster.NumConns = 3
		cluster.ConnectTimeout = 5 * time.Second
		cluster.Timeout = 2 * time.Second
		cluster.RetryPolicy = &gocql.ExponentialBackoffRetryPolicy{
			NumRetries: 3,
			Min:        100 * time.Millisecond,
			Max:        1 * time.Second,
		}

		session, err := cluster.CreateSession()
		if err == nil {
			return session, nil
		}

		if time.Now().After(deadline) {
			return nil, fmt.Errorf("scylla connection failed after 2m: %w", err)
		}

		slog.Warn("scylla not ready, retrying", "err", err, "backoff", backoff)
		time.Sleep(backoff)
		backoff = min(backoff*2, 30*time.Second)
	}
}
