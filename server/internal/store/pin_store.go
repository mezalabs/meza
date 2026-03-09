package store

import (
	"context"
	"fmt"
	"time"

	"github.com/mezalabs/meza/internal/models"
	"github.com/jackc/pgx/v5/pgxpool"
)

// PinStore implements PinStorer using PostgreSQL.
type PinStore struct {
	pool *pgxpool.Pool
}

// NewPinStore creates a new PinStore backed by a pgxpool.Pool.
func NewPinStore(pool *pgxpool.Pool) *PinStore {
	return &PinStore{pool: pool}
}

func (s *PinStore) PinMessage(ctx context.Context, channelID, messageID, pinnedBy string) error {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	_, err := s.pool.Exec(ctx,
		`INSERT INTO pinned_messages (channel_id, message_id, pinned_by)
		 VALUES ($1, $2, $3)
		 ON CONFLICT (channel_id, message_id) DO NOTHING`,
		channelID, messageID, pinnedBy,
	)
	if err != nil {
		return fmt.Errorf("pin message: %w", err)
	}
	return nil
}

func (s *PinStore) UnpinMessage(ctx context.Context, channelID, messageID string) error {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	_, err := s.pool.Exec(ctx,
		`DELETE FROM pinned_messages WHERE channel_id = $1 AND message_id = $2`,
		channelID, messageID,
	)
	if err != nil {
		return fmt.Errorf("unpin message: %w", err)
	}
	return nil
}

func (s *PinStore) GetPinnedMessages(ctx context.Context, channelID string, before time.Time, limit int) ([]*models.PinnedMessage, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	if limit <= 0 || limit > 100 {
		limit = 50
	}

	rows, err := s.pool.Query(ctx,
		`SELECT channel_id, message_id, pinned_by, pinned_at
		 FROM pinned_messages
		 WHERE channel_id = $1 AND pinned_at < $2
		 ORDER BY pinned_at DESC
		 LIMIT $3`,
		channelID, before, limit,
	)
	if err != nil {
		return nil, fmt.Errorf("query pinned messages: %w", err)
	}
	defer rows.Close()

	var pins []*models.PinnedMessage
	for rows.Next() {
		var p models.PinnedMessage
		if err := rows.Scan(&p.ChannelID, &p.MessageID, &p.PinnedBy, &p.PinnedAt); err != nil {
			return nil, fmt.Errorf("scan pinned message: %w", err)
		}
		pins = append(pins, &p)
	}
	return pins, rows.Err()
}

func (s *PinStore) IsPinned(ctx context.Context, channelID, messageID string) (bool, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	var exists bool
	err := s.pool.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM pinned_messages WHERE channel_id = $1 AND message_id = $2)`,
		channelID, messageID,
	).Scan(&exists)
	if err != nil {
		return false, fmt.Errorf("check pinned: %w", err)
	}
	return exists, nil
}
