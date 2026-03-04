package store

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/meza-chat/meza/internal/models"
)

// metadataParam converts json.RawMessage ([]byte) to *string so pgx v5
// sends it as text instead of bytea, which PostgreSQL can cast to jsonb.
func metadataParam(m json.RawMessage) *string {
	if m == nil {
		return nil
	}
	s := string(m)
	return &s
}

// AuditLogStore implements AuditLogStorer using PostgreSQL.
type AuditLogStore struct {
	pool *pgxpool.Pool
}

// NewAuditLogStore creates a new AuditLogStore backed by a pgxpool.Pool.
func NewAuditLogStore(pool *pgxpool.Pool) *AuditLogStore {
	return &AuditLogStore{pool: pool}
}

func (s *AuditLogStore) CreateEntry(ctx context.Context, entry *models.AuditLogEntry) error {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	_, err := s.pool.Exec(ctx,
		`INSERT INTO audit_log (id, server_id, action, actor_id, target_id, target_type, metadata, created_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
		entry.ID, entry.ServerID, entry.Action, entry.ActorID,
		entry.TargetID, entry.TargetType, metadataParam(entry.Metadata), entry.CreatedAt,
	)
	if err != nil {
		return fmt.Errorf("insert audit log entry: %w", err)
	}
	return nil
}

func (s *AuditLogStore) ListEntries(ctx context.Context, serverID string, before time.Time, limit int) ([]*models.AuditLogEntry, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	if limit <= 0 || limit > 100 {
		limit = 50
	}

	rows, err := s.pool.Query(ctx,
		`SELECT id, server_id, action, actor_id, target_id, target_type, metadata, created_at
		 FROM audit_log
		 WHERE server_id = $1 AND created_at < $2
		 ORDER BY created_at DESC
		 LIMIT $3`,
		serverID, before, limit,
	)
	if err != nil {
		return nil, fmt.Errorf("query audit log: %w", err)
	}
	defer rows.Close()

	var entries []*models.AuditLogEntry
	for rows.Next() {
		var e models.AuditLogEntry
		if err := rows.Scan(&e.ID, &e.ServerID, &e.Action, &e.ActorID, &e.TargetID, &e.TargetType, &e.Metadata, &e.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan audit log entry: %w", err)
		}
		entries = append(entries, &e)
	}
	return entries, rows.Err()
}
