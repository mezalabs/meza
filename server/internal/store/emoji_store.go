package store

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/mezalabs/meza/internal/models"
)

// EmojiStore implements EmojiStorer using PostgreSQL.
type EmojiStore struct {
	pool *pgxpool.Pool
}

// NewEmojiStore creates a new EmojiStore backed by a pgxpool.Pool.
func NewEmojiStore(pool *pgxpool.Pool) *EmojiStore {
	return &EmojiStore{pool: pool}
}

// CreateEmoji atomically checks the quota limit and inserts the emoji.
func (s *EmojiStore) CreateEmoji(ctx context.Context, emoji *models.Emoji, maxPersonal, maxServer int) (*models.Emoji, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	var query string
	var args []any

	if emoji.ServerID == "" {
		// Personal emoji: atomic count+insert with quota guard.
		query = `INSERT INTO server_emojis (id, server_id, user_id, name, attachment_id, animated, creator_id, created_at)
			SELECT $1, NULL, $2, $3, $4, (a.content_type = 'image/gif'), $2, $6
			FROM attachments a
			WHERE a.id = $4
			  AND a.status = 'completed'
			  AND a.uploader_id = $2
			  AND a.upload_purpose = 'server_emoji'
			  AND (SELECT COUNT(*) FROM server_emojis WHERE user_id = $2 AND server_id IS NULL) < $5
			RETURNING id, server_id, user_id, name, attachment_id, animated, creator_id, created_at`
		args = []any{emoji.ID, emoji.UserID, emoji.Name, emoji.AttachmentID, maxPersonal, emoji.CreatedAt}
	} else {
		// Server emoji: atomic count+insert with quota guard.
		query = `INSERT INTO server_emojis (id, server_id, user_id, name, attachment_id, animated, creator_id, created_at)
			SELECT $1, $2, $3, $4, $5, (a.content_type = 'image/gif'), $3, $7
			FROM attachments a
			WHERE a.id = $5
			  AND a.status = 'completed'
			  AND a.uploader_id = $3
			  AND a.upload_purpose = 'server_emoji'
			  AND (SELECT COUNT(*) FROM server_emojis WHERE server_id = $2) < $6
			RETURNING id, server_id, user_id, name, attachment_id, animated, creator_id, created_at`
		args = []any{emoji.ID, emoji.ServerID, emoji.UserID, emoji.Name, emoji.AttachmentID, maxServer, emoji.CreatedAt}
	}

	var result models.Emoji
	var serverID *string
	err := s.pool.QueryRow(ctx, query, args...).Scan(
		&result.ID, &serverID, &result.UserID, &result.Name, &result.AttachmentID, &result.Animated, &result.CreatorID, &result.CreatedAt,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil // quota exceeded or attachment not valid
		}
		return nil, fmt.Errorf("insert emoji: %w", err)
	}
	if serverID != nil {
		result.ServerID = *serverID
	}
	return &result, nil
}

func (s *EmojiStore) GetEmoji(ctx context.Context, emojiID string) (*models.Emoji, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	var e models.Emoji
	var serverID *string
	err := s.pool.QueryRow(ctx,
		`SELECT id, server_id, user_id, name, attachment_id, animated, creator_id, created_at
		 FROM server_emojis WHERE id = $1`, emojiID,
	).Scan(&e.ID, &serverID, &e.UserID, &e.Name, &e.AttachmentID, &e.Animated, &e.CreatorID, &e.CreatedAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, fmt.Errorf("emoji not found")
		}
		return nil, fmt.Errorf("query emoji: %w", err)
	}
	if serverID != nil {
		e.ServerID = *serverID
	}
	return &e, nil
}

func (s *EmojiStore) ListEmojis(ctx context.Context, serverID string) ([]*models.Emoji, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	rows, err := s.pool.Query(ctx,
		`SELECT id, server_id, user_id, name, attachment_id, animated, creator_id, created_at
		 FROM server_emojis WHERE server_id = $1
		 ORDER BY name`, serverID,
	)
	if err != nil {
		return nil, fmt.Errorf("query emojis: %w", err)
	}
	defer rows.Close()

	return scanEmojis(rows)
}

func (s *EmojiStore) ListEmojisByUser(ctx context.Context, userID string) ([]*models.Emoji, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	rows, err := s.pool.Query(ctx,
		`SELECT id, server_id, user_id, name, attachment_id, animated, creator_id, created_at
		 FROM server_emojis WHERE user_id = $1 AND server_id IS NULL
		 ORDER BY name`, userID,
	)
	if err != nil {
		return nil, fmt.Errorf("query user emojis: %w", err)
	}
	defer rows.Close()

	return scanEmojis(rows)
}

func (s *EmojiStore) UpdateEmoji(ctx context.Context, emojiID string, name *string) (*models.Emoji, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	setClauses := []string{}
	args := []any{}
	argIdx := 1

	if name != nil {
		setClauses = append(setClauses, fmt.Sprintf("name = $%d", argIdx))
		args = append(args, *name)
		argIdx++
	}

	if len(setClauses) == 0 {
		return s.GetEmoji(ctx, emojiID)
	}

	query := fmt.Sprintf(
		"UPDATE server_emojis SET %s WHERE id = $%d RETURNING id, server_id, user_id, name, attachment_id, animated, creator_id, created_at",
		strings.Join(setClauses, ", "),
		argIdx,
	)
	args = append(args, emojiID)

	var e models.Emoji
	var serverID *string
	err := s.pool.QueryRow(ctx, query, args...).Scan(
		&e.ID, &serverID, &e.UserID, &e.Name, &e.AttachmentID, &e.Animated, &e.CreatorID, &e.CreatedAt,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, fmt.Errorf("emoji not found")
		}
		return nil, fmt.Errorf("update emoji: %w", err)
	}
	if serverID != nil {
		e.ServerID = *serverID
	}
	return &e, nil
}

func (s *EmojiStore) DeleteEmoji(ctx context.Context, emojiID string) error {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	result, err := s.pool.Exec(ctx, `DELETE FROM server_emojis WHERE id = $1`, emojiID)
	if err != nil {
		return fmt.Errorf("delete emoji: %w", err)
	}
	if result.RowsAffected() == 0 {
		return fmt.Errorf("emoji not found")
	}
	return nil
}

func (s *EmojiStore) CountEmojisByServer(ctx context.Context, serverID string) (int, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	var count int
	err := s.pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM server_emojis WHERE server_id = $1`, serverID,
	).Scan(&count)
	if err != nil {
		return 0, fmt.Errorf("count emojis: %w", err)
	}
	return count, nil
}

func (s *EmojiStore) CountEmojisByUser(ctx context.Context, userID string) (int, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	var count int
	err := s.pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM server_emojis WHERE user_id = $1 AND server_id IS NULL`, userID,
	).Scan(&count)
	if err != nil {
		return 0, fmt.Errorf("count user emojis: %w", err)
	}
	return count, nil
}

func scanEmojis(rows pgx.Rows) ([]*models.Emoji, error) {
	var emojis []*models.Emoji
	for rows.Next() {
		var e models.Emoji
		var serverID *string
		if err := rows.Scan(&e.ID, &serverID, &e.UserID, &e.Name, &e.AttachmentID, &e.Animated, &e.CreatorID, &e.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan emoji: %w", err)
		}
		if serverID != nil {
			e.ServerID = *serverID
		}
		emojis = append(emojis, &e)
	}
	return emojis, rows.Err()
}
