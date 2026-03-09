package store

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/mezalabs/meza/internal/models"
)

// ReactionStore implements ReactionStorer using PostgreSQL.
type ReactionStore struct {
	pool *pgxpool.Pool
}

// NewReactionStore creates a new ReactionStore backed by a pgxpool.Pool.
func NewReactionStore(pool *pgxpool.Pool) *ReactionStore {
	return &ReactionStore{pool: pool}
}

func (s *ReactionStore) AddReaction(ctx context.Context, r *models.Reaction) error {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	_, err := s.pool.Exec(ctx,
		`INSERT INTO message_reactions (channel_id, message_id, user_id, emoji, created_at)
		 VALUES ($1, $2, $3, $4, now())
		 ON CONFLICT (channel_id, message_id, user_id, emoji) DO NOTHING`,
		r.ChannelID, r.MessageID, r.UserID, r.Emoji,
	)
	if err != nil {
		return fmt.Errorf("add reaction: %w", err)
	}
	return nil
}

func (s *ReactionStore) RemoveReaction(ctx context.Context, channelID, messageID, userID, emoji string) error {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	_, err := s.pool.Exec(ctx,
		`DELETE FROM message_reactions
		 WHERE channel_id = $1 AND message_id = $2 AND user_id = $3 AND emoji = $4`,
		channelID, messageID, userID, emoji,
	)
	if err != nil {
		return fmt.Errorf("remove reaction: %w", err)
	}
	return nil
}

func (s *ReactionStore) GetReactionGroups(ctx context.Context, channelID string, messageIDs []string, callerID string) (map[string][]*models.ReactionGroup, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	rows, err := s.pool.Query(ctx,
		`SELECT message_id, emoji,
		        bool_or(user_id = $3) as me,
		        array_agg(user_id ORDER BY created_at) as user_ids
		 FROM message_reactions
		 WHERE channel_id = $1 AND message_id = ANY($2)
		 GROUP BY message_id, emoji
		 ORDER BY min(created_at)`,
		channelID, messageIDs, callerID,
	)
	if err != nil {
		return nil, fmt.Errorf("query reaction groups: %w", err)
	}
	defer rows.Close()

	result := make(map[string][]*models.ReactionGroup)
	for rows.Next() {
		var messageID, emoji string
		var me bool
		var userIDs []string
		if err := rows.Scan(&messageID, &emoji, &me, &userIDs); err != nil {
			return nil, fmt.Errorf("scan reaction group: %w", err)
		}
		result[messageID] = append(result[messageID], &models.ReactionGroup{
			Emoji:   emoji,
			Me:      me,
			UserIDs: userIDs,
		})
	}
	return result, rows.Err()
}

func (s *ReactionStore) CountUniqueEmojis(ctx context.Context, channelID, messageID string) (int, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	var count int
	err := s.pool.QueryRow(ctx,
		`SELECT COUNT(DISTINCT emoji)
		 FROM message_reactions
		 WHERE channel_id = $1 AND message_id = $2`,
		channelID, messageID,
	).Scan(&count)
	if err != nil {
		return 0, fmt.Errorf("count unique emojis: %w", err)
	}
	return count, nil
}

func (s *ReactionStore) RemoveAllMessageReactions(ctx context.Context, channelID, messageID string) error {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	_, err := s.pool.Exec(ctx,
		`DELETE FROM message_reactions
		 WHERE channel_id = $1 AND message_id = $2`,
		channelID, messageID,
	)
	if err != nil {
		return fmt.Errorf("remove all message reactions: %w", err)
	}
	return nil
}
