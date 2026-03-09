package store

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/mezalabs/meza/internal/models"
)

// SoundboardStore implements SoundboardStorer using PostgreSQL.
type SoundboardStore struct {
	pool *pgxpool.Pool
}

// NewSoundboardStore creates a new SoundboardStore backed by a pgxpool.Pool.
func NewSoundboardStore(pool *pgxpool.Pool) *SoundboardStore {
	return &SoundboardStore{pool: pool}
}

// CreateSound atomically checks the quota limit and inserts the sound.
// Returns nil if the limit would be exceeded.
func (s *SoundboardStore) CreateSound(ctx context.Context, sound *models.SoundboardSound, maxPersonal, maxServer int) (*models.SoundboardSound, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	var query string
	var args []any

	if sound.ServerID == "" {
		// Personal sound: atomic count+insert with quota guard.
		query = `INSERT INTO soundboard_sounds (id, user_id, server_id, name, attachment_id, created_at)
			SELECT $1, $2, NULL, $3, a.id, $5
			FROM attachments a
			WHERE a.id = $4
			  AND a.status = 'completed'
			  AND a.uploader_id = $2
			  AND a.upload_purpose = 'soundboard'
			  AND (SELECT COUNT(*) FROM soundboard_sounds WHERE user_id = $2 AND server_id IS NULL) < $6
			RETURNING id, user_id, server_id, name, attachment_id, created_at`
		args = []any{sound.ID, sound.UserID, sound.Name, sound.AttachmentID, sound.CreatedAt, maxPersonal}
	} else {
		// Server sound: atomic count+insert with quota guard.
		query = `INSERT INTO soundboard_sounds (id, user_id, server_id, name, attachment_id, created_at)
			SELECT $1, $2, $3, $4, a.id, $6
			FROM attachments a
			WHERE a.id = $5
			  AND a.status = 'completed'
			  AND a.uploader_id = $2
			  AND a.upload_purpose = 'soundboard'
			  AND (SELECT COUNT(*) FROM soundboard_sounds WHERE server_id = $3) < $7
			RETURNING id, user_id, server_id, name, attachment_id, created_at`
		args = []any{sound.ID, sound.UserID, sound.ServerID, sound.Name, sound.AttachmentID, sound.CreatedAt, maxServer}
	}

	var result models.SoundboardSound
	var serverID *string
	err := s.pool.QueryRow(ctx, query, args...).Scan(
		&result.ID, &result.UserID, &serverID, &result.Name, &result.AttachmentID, &result.CreatedAt,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil // quota exceeded or attachment not valid
		}
		return nil, fmt.Errorf("insert sound: %w", err)
	}
	if serverID != nil {
		result.ServerID = *serverID
	}
	return &result, nil
}

func (s *SoundboardStore) GetSound(ctx context.Context, soundID string) (*models.SoundboardSound, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	var snd models.SoundboardSound
	var serverID *string
	err := s.pool.QueryRow(ctx,
		`SELECT id, user_id, server_id, name, attachment_id, created_at
		 FROM soundboard_sounds WHERE id = $1`, soundID,
	).Scan(&snd.ID, &snd.UserID, &serverID, &snd.Name, &snd.AttachmentID, &snd.CreatedAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, fmt.Errorf("sound not found")
		}
		return nil, fmt.Errorf("query sound: %w", err)
	}
	if serverID != nil {
		snd.ServerID = *serverID
	}
	return &snd, nil
}

func (s *SoundboardStore) ListSoundsByUser(ctx context.Context, userID string) ([]*models.SoundboardSound, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	rows, err := s.pool.Query(ctx,
		`SELECT id, user_id, server_id, name, attachment_id, created_at
		 FROM soundboard_sounds WHERE user_id = $1 AND server_id IS NULL
		 ORDER BY name`, userID,
	)
	if err != nil {
		return nil, fmt.Errorf("query user sounds: %w", err)
	}
	defer rows.Close()

	return scanSounds(rows)
}

func (s *SoundboardStore) ListSoundsByServer(ctx context.Context, serverID string) ([]*models.SoundboardSound, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	rows, err := s.pool.Query(ctx,
		`SELECT id, user_id, server_id, name, attachment_id, created_at
		 FROM soundboard_sounds WHERE server_id = $1
		 ORDER BY name`, serverID,
	)
	if err != nil {
		return nil, fmt.Errorf("query server sounds: %w", err)
	}
	defer rows.Close()

	return scanSounds(rows)
}

func (s *SoundboardStore) UpdateSound(ctx context.Context, soundID string, name string) (*models.SoundboardSound, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	var snd models.SoundboardSound
	var serverID *string
	err := s.pool.QueryRow(ctx,
		`UPDATE soundboard_sounds SET name = $1 WHERE id = $2
		 RETURNING id, user_id, server_id, name, attachment_id, created_at`,
		name, soundID,
	).Scan(&snd.ID, &snd.UserID, &serverID, &snd.Name, &snd.AttachmentID, &snd.CreatedAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, fmt.Errorf("sound not found")
		}
		return nil, fmt.Errorf("update sound: %w", err)
	}
	if serverID != nil {
		snd.ServerID = *serverID
	}
	return &snd, nil
}

func (s *SoundboardStore) DeleteSound(ctx context.Context, soundID string) error {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	result, err := s.pool.Exec(ctx, `DELETE FROM soundboard_sounds WHERE id = $1`, soundID)
	if err != nil {
		return fmt.Errorf("delete sound: %w", err)
	}
	if result.RowsAffected() == 0 {
		return fmt.Errorf("sound not found")
	}
	return nil
}

func scanSounds(rows pgx.Rows) ([]*models.SoundboardSound, error) {
	var sounds []*models.SoundboardSound
	for rows.Next() {
		var snd models.SoundboardSound
		var serverID *string
		if err := rows.Scan(&snd.ID, &snd.UserID, &serverID, &snd.Name, &snd.AttachmentID, &snd.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan sound: %w", err)
		}
		if serverID != nil {
			snd.ServerID = *serverID
		}
		sounds = append(sounds, &snd)
	}
	return sounds, rows.Err()
}
