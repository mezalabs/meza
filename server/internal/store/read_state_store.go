package store

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/mezalabs/meza/internal/models"
)

// ReadStateStore implements ReadStateStorer using PostgreSQL.
type ReadStateStore struct {
	pool *pgxpool.Pool
}

// NewReadStateStore creates a new ReadStateStore backed by a pgxpool.Pool.
func NewReadStateStore(pool *pgxpool.Pool) *ReadStateStore {
	return &ReadStateStore{pool: pool}
}

func (s *ReadStateStore) UpsertReadState(ctx context.Context, userID, channelID, messageID string) error {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	_, err := s.pool.Exec(ctx,
		`INSERT INTO channel_read_states (user_id, channel_id, last_read_message_id, updated_at)
		 VALUES ($1, $2, $3, now())
		 ON CONFLICT (user_id, channel_id)
		 DO UPDATE SET last_read_message_id = EXCLUDED.last_read_message_id,
		               updated_at = now()
		 WHERE channel_read_states.last_read_message_id < EXCLUDED.last_read_message_id`,
		userID, channelID, messageID,
	)
	if err != nil {
		return fmt.Errorf("upsert read state: %w", err)
	}
	return nil
}

func (s *ReadStateStore) GetReadState(ctx context.Context, userID, channelID string) (*models.ReadState, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	var rs models.ReadState
	err := s.pool.QueryRow(ctx,
		`SELECT user_id, channel_id, last_read_message_id, updated_at
		 FROM channel_read_states
		 WHERE user_id = $1 AND channel_id = $2`,
		userID, channelID,
	).Scan(&rs.UserID, &rs.ChannelID, &rs.LastReadMessageID, &rs.UpdatedAt)
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil, nil
		}
		return nil, fmt.Errorf("get read state: %w", err)
	}
	return &rs, nil
}

func (s *ReadStateStore) GetReadStates(ctx context.Context, userID string) ([]models.ReadState, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	rows, err := s.pool.Query(ctx,
		`SELECT user_id, channel_id, last_read_message_id, updated_at
		 FROM channel_read_states
		 WHERE user_id = $1`,
		userID,
	)
	if err != nil {
		return nil, fmt.Errorf("query read states: %w", err)
	}
	defer rows.Close()

	var states []models.ReadState
	for rows.Next() {
		var rs models.ReadState
		if err := rows.Scan(&rs.UserID, &rs.ChannelID, &rs.LastReadMessageID, &rs.UpdatedAt); err != nil {
			return nil, fmt.Errorf("scan read state: %w", err)
		}
		states = append(states, rs)
	}
	return states, rows.Err()
}

func (s *ReadStateStore) MarkServerAsRead(ctx context.Context, userID string, channelIDs []string, messageIDs []string) error {
	if len(channelIDs) != len(messageIDs) || len(channelIDs) == 0 {
		return nil
	}

	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	batch := &pgx.Batch{}
	for i := range channelIDs {
		batch.Queue(
			`INSERT INTO channel_read_states (user_id, channel_id, last_read_message_id, updated_at)
			 VALUES ($1, $2, $3, now())
			 ON CONFLICT (user_id, channel_id)
			 DO UPDATE SET last_read_message_id = EXCLUDED.last_read_message_id,
			               updated_at = now()
			 WHERE channel_read_states.last_read_message_id < EXCLUDED.last_read_message_id`,
			userID, channelIDs[i], messageIDs[i],
		)
	}

	results := s.pool.SendBatch(ctx, batch)
	defer results.Close()

	for range channelIDs {
		if _, err := results.Exec(); err != nil {
			return fmt.Errorf("mark server as read: %w", err)
		}
	}
	return nil
}
