package store

import (
	"context"
	"fmt"

	"github.com/mezalabs/meza/internal/models"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// BlockStore implements BlockStorer using PostgreSQL.
type BlockStore struct {
	pool *pgxpool.Pool
}

// NewBlockStore creates a new BlockStore backed by a pgxpool.Pool.
func NewBlockStore(pool *pgxpool.Pool) *BlockStore {
	return &BlockStore{pool: pool}
}

func (s *BlockStore) BlockUser(ctx context.Context, blockerID, blockedID string) error {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	_, err := s.pool.Exec(ctx,
		`INSERT INTO user_blocks (blocker_id, blocked_id)
		 VALUES ($1, $2)
		 ON CONFLICT (blocker_id, blocked_id) DO NOTHING`,
		blockerID, blockedID,
	)
	if err != nil {
		return fmt.Errorf("insert block: %w", err)
	}
	return nil
}

// BlockUserTx inserts a block record within an existing transaction.
func (s *BlockStore) BlockUserTx(ctx context.Context, tx pgx.Tx, blockerID, blockedID string) error {
	_, err := tx.Exec(ctx,
		`INSERT INTO user_blocks (blocker_id, blocked_id)
		 VALUES ($1, $2)
		 ON CONFLICT (blocker_id, blocked_id) DO NOTHING`,
		blockerID, blockedID,
	)
	if err != nil {
		return fmt.Errorf("insert block: %w", err)
	}
	return nil
}

func (s *BlockStore) UnblockUser(ctx context.Context, blockerID, blockedID string) error {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	_, err := s.pool.Exec(ctx,
		`DELETE FROM user_blocks WHERE blocker_id = $1 AND blocked_id = $2`,
		blockerID, blockedID,
	)
	if err != nil {
		return fmt.Errorf("delete block: %w", err)
	}
	return nil
}

// IsBlockedEither checks if either user has blocked the other.
func (s *BlockStore) IsBlockedEither(ctx context.Context, userA, userB string) (bool, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	var exists bool
	err := s.pool.QueryRow(ctx,
		`SELECT EXISTS(
			SELECT 1 FROM user_blocks
			WHERE (blocker_id = $1 AND blocked_id = $2)
			   OR (blocker_id = $2 AND blocked_id = $1)
		)`,
		userA, userB,
	).Scan(&exists)
	if err != nil {
		return false, fmt.Errorf("check block either: %w", err)
	}
	return exists, nil
}

func (s *BlockStore) ListBlocks(ctx context.Context, blockerID string) ([]string, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	rows, err := s.pool.Query(ctx,
		`SELECT blocked_id FROM user_blocks WHERE blocker_id = $1 ORDER BY created_at DESC`,
		blockerID,
	)
	if err != nil {
		return nil, fmt.Errorf("query blocks: %w", err)
	}
	defer rows.Close()

	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("scan block: %w", err)
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// ListBlocksWithUsers returns full user models for all users blocked by the given blocker,
// using a single JOIN query instead of N+1 individual lookups.
func (s *BlockStore) ListBlocksWithUsers(ctx context.Context, blockerID string) ([]*models.User, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	rows, err := s.pool.Query(ctx,
		`SELECT u.id, COALESCE(u.email,''), u.username, COALESCE(u.display_name,''),
		        COALESCE(u.avatar_url,''), u.emoji_scale, u.created_at,
		        COALESCE(u.bio,''), COALESCE(u.pronouns,''), COALESCE(u.banner_url,''),
		        COALESCE(u.theme_color_primary,''), COALESCE(u.theme_color_secondary,''),
		        u.simple_mode, u.dm_privacy
		 FROM user_blocks b
		 JOIN users u ON u.id = b.blocked_id
		 WHERE b.blocker_id = $1
		 ORDER BY b.created_at DESC`,
		blockerID,
	)
	if err != nil {
		return nil, fmt.Errorf("query blocks with users: %w", err)
	}
	defer rows.Close()

	var users []*models.User
	for rows.Next() {
		var u models.User
		if err := rows.Scan(
			&u.ID, &u.Email, &u.Username, &u.DisplayName,
			&u.AvatarURL, &u.EmojiScale, &u.CreatedAt,
			&u.Bio, &u.Pronouns, &u.BannerURL,
			&u.ThemeColorPrimary, &u.ThemeColorSecondary,
			&u.SimpleMode, &u.DMPrivacy,
		); err != nil {
			return nil, fmt.Errorf("scan blocked user: %w", err)
		}
		users = append(users, &u)
	}
	return users, rows.Err()
}
