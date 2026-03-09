package store

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/mezalabs/meza/internal/models"
)

// BanStore implements BanStorer using PostgreSQL.
type BanStore struct {
	pool *pgxpool.Pool
}

// NewBanStore creates a new BanStore backed by a pgxpool.Pool.
func NewBanStore(pool *pgxpool.Pool) *BanStore {
	return &BanStore{pool: pool}
}

// CreateBanAndRemoveMember atomically bans a user AND removes their membership.
// The hierarchy check is re-verified inside the transaction with FOR UPDATE to prevent TOCTOU races.
// Member deletion uses ON DELETE CASCADE from member_roles FK.
func (s *BanStore) CreateBanAndRemoveMember(ctx context.Context, ban *models.Ban, callerPosition int) error {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx)

	// Re-check target's position inside transaction with row lock (prevents TOCTOU).
	// Lock rows first, then aggregate — FOR UPDATE can't be used with aggregates directly.
	var maxPos int
	err = tx.QueryRow(ctx,
		`SELECT COALESCE(MAX(r.position), 0)
		 FROM (
		   SELECT mr.role_id
		   FROM member_roles mr
		   WHERE mr.user_id = $1 AND mr.server_id = $2
		   FOR UPDATE OF mr
		 ) locked
		 JOIN roles r ON r.id = locked.role_id`,
		ban.UserID, ban.ServerID,
	).Scan(&maxPos)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("get target position: %w", err)
	}
	if maxPos >= callerPosition {
		return fmt.Errorf("target has higher or equal position")
	}

	_, err = tx.Exec(ctx,
		`INSERT INTO bans (server_id, user_id, reason, banned_by, created_at)
		 VALUES ($1, $2, $3, $4, $5)`,
		ban.ServerID, ban.UserID, ban.Reason, ban.BannedBy, ban.CreatedAt,
	)
	if err != nil {
		return fmt.Errorf("insert ban: %w", err)
	}

	// Delete member -- CASCADE handles member_roles automatically.
	_, err = tx.Exec(ctx,
		`DELETE FROM members WHERE user_id = $1 AND server_id = $2`,
		ban.UserID, ban.ServerID,
	)
	if err != nil {
		return fmt.Errorf("delete member: %w", err)
	}

	return tx.Commit(ctx)
}

// CreateBan creates a ban record without removing a member (used for pre-emptive bans).
// Uses ON CONFLICT to handle concurrent ban attempts idempotently.
// Returns true if the ban was newly created, false if it already existed.
func (s *BanStore) CreateBan(ctx context.Context, ban *models.Ban) (bool, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	result, err := s.pool.Exec(ctx,
		`INSERT INTO bans (server_id, user_id, reason, banned_by, created_at)
		 VALUES ($1, $2, $3, $4, $5)
		 ON CONFLICT (server_id, user_id) DO NOTHING`,
		ban.ServerID, ban.UserID, ban.Reason, ban.BannedBy, ban.CreatedAt,
	)
	if err != nil {
		return false, fmt.Errorf("insert ban: %w", err)
	}
	return result.RowsAffected() > 0, nil
}

func (s *BanStore) IsBanned(ctx context.Context, serverID, userID string) (bool, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	var exists bool
	err := s.pool.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM bans WHERE server_id = $1 AND user_id = $2)`,
		serverID, userID,
	).Scan(&exists)
	if err != nil {
		return false, fmt.Errorf("check ban: %w", err)
	}
	return exists, nil
}

func (s *BanStore) DeleteBan(ctx context.Context, serverID, userID string) error {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	_, err := s.pool.Exec(ctx,
		`DELETE FROM bans WHERE server_id = $1 AND user_id = $2`,
		serverID, userID,
	)
	if err != nil {
		return fmt.Errorf("delete ban: %w", err)
	}
	return nil
}

func (s *BanStore) ListBans(ctx context.Context, serverID string) ([]*models.Ban, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	rows, err := s.pool.Query(ctx,
		`SELECT server_id, user_id, reason, banned_by, created_at
		 FROM bans WHERE server_id = $1
		 ORDER BY created_at DESC`,
		serverID,
	)
	if err != nil {
		return nil, fmt.Errorf("query bans: %w", err)
	}
	defer rows.Close()

	var bans []*models.Ban
	for rows.Next() {
		var b models.Ban
		if err := rows.Scan(&b.ServerID, &b.UserID, &b.Reason, &b.BannedBy, &b.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan ban: %w", err)
		}
		bans = append(bans, &b)
	}
	return bans, rows.Err()
}
