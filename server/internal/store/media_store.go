package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/meza-chat/meza/internal/models"
)

// MediaStore implements MediaStorer using PostgreSQL.
type MediaStore struct {
	pool *pgxpool.Pool
}

// NewMediaStore creates a new MediaStore backed by a pgxpool.Pool.
func NewMediaStore(pool *pgxpool.Pool) *MediaStore {
	return &MediaStore{pool: pool}
}

// attachmentColumns is the canonical column list for attachment queries.
const attachmentColumns = `id, uploader_id, upload_purpose, object_key, thumbnail_key, filename, content_type, original_content_type, size_bytes, width, height, status, micro_thumbnail_data, encrypted_key, created_at, updated_at, completed_at, expires_at`

func scanAttachment(row interface{ Scan(dest ...any) error }, a *models.Attachment) error {
	return row.Scan(
		&a.ID, &a.UploaderID, &a.UploadPurpose, &a.ObjectKey, &a.ThumbnailKey,
		&a.Filename, &a.ContentType, &a.OriginalContentType, &a.SizeBytes, &a.Width, &a.Height,
		&a.Status, &a.MicroThumbnailData, &a.EncryptedKey, &a.CreatedAt, &a.UpdatedAt, &a.CompletedAt, &a.ExpiresAt,
	)
}

func (s *MediaStore) CreateAttachment(ctx context.Context, attachment *models.Attachment) (*models.Attachment, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	var a models.Attachment
	err := scanAttachment(s.pool.QueryRow(ctx,
		`INSERT INTO attachments (id, uploader_id, upload_purpose, object_key, thumbnail_key, filename, content_type, original_content_type, size_bytes, width, height, status, created_at, updated_at, completed_at, expires_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
		 RETURNING `+attachmentColumns,
		attachment.ID, attachment.UploaderID, attachment.UploadPurpose, attachment.ObjectKey, attachment.ThumbnailKey,
		attachment.Filename, attachment.ContentType, attachment.OriginalContentType, attachment.SizeBytes, attachment.Width, attachment.Height,
		attachment.Status, attachment.CreatedAt, attachment.UpdatedAt, attachment.CompletedAt, attachment.ExpiresAt,
	), &a)
	if err != nil {
		return nil, fmt.Errorf("insert attachment: %w", err)
	}
	return &a, nil
}

func (s *MediaStore) GetAttachment(ctx context.Context, id string) (*models.Attachment, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	var a models.Attachment
	err := scanAttachment(s.pool.QueryRow(ctx,
		`SELECT `+attachmentColumns+` FROM attachments WHERE id = $1`, id,
	), &a)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, fmt.Errorf("attachment not found")
		}
		return nil, fmt.Errorf("query attachment: %w", err)
	}
	return &a, nil
}

func (s *MediaStore) GetAttachmentsByIDs(ctx context.Context, attachmentIDs []string) (map[string]*models.Attachment, error) {
	if len(attachmentIDs) == 0 {
		return map[string]*models.Attachment{}, nil
	}
	if len(attachmentIDs) > 1000 {
		return nil, fmt.Errorf("too many attachment IDs: %d (max 1000)", len(attachmentIDs))
	}

	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	rows, err := s.pool.Query(ctx,
		`SELECT `+attachmentColumns+` FROM attachments WHERE id = ANY($1)`,
		attachmentIDs,
	)
	if err != nil {
		return nil, fmt.Errorf("query attachments by IDs: %w", err)
	}
	defer rows.Close()

	result := make(map[string]*models.Attachment, len(attachmentIDs))
	for rows.Next() {
		var a models.Attachment
		if err := scanAttachment(rows, &a); err != nil {
			return nil, fmt.Errorf("scan attachment: %w", err)
		}
		result[a.ID] = &a
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate attachments: %w", err)
	}
	return result, nil
}

func (s *MediaStore) CountPendingByUploader(ctx context.Context, uploaderID string) (int, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	var count int
	err := s.pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM attachments WHERE uploader_id = $1 AND status = 'pending'`, uploaderID,
	).Scan(&count)
	if err != nil {
		return 0, fmt.Errorf("count pending attachments: %w", err)
	}
	return count, nil
}

func (s *MediaStore) TransitionToProcessing(ctx context.Context, id, uploaderID string) (*models.Attachment, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	var a models.Attachment
	err := scanAttachment(s.pool.QueryRow(ctx,
		`UPDATE attachments SET status = 'processing', expires_at = now() + interval '1 hour', updated_at = now()
		 WHERE id = $1 AND uploader_id = $2 AND status = 'pending'
		 RETURNING `+attachmentColumns,
		id, uploaderID,
	), &a)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, fmt.Errorf("transition attachment to processing: %w", err)
	}
	return &a, nil
}

func (s *MediaStore) UpdateAttachmentCompleted(ctx context.Context, id string, sizeBytes int64, contentType string, width, height int, thumbnailKey string, microThumbnailData string, encryptedKey []byte) error {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	tag, err := s.pool.Exec(ctx,
		`UPDATE attachments SET status = 'completed', size_bytes = $2, content_type = $3, width = $4, height = $5, thumbnail_key = $6, micro_thumbnail_data = $7, encrypted_key = $8, completed_at = now(), expires_at = NULL, updated_at = now()
		 WHERE id = $1 AND status = 'processing'`,
		id, sizeBytes, contentType, width, height, thumbnailKey, microThumbnailData, encryptedKey,
	)
	if err != nil {
		return fmt.Errorf("update attachment completed: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("attachment %s not in processing state", id)
	}
	return nil
}

func (s *MediaStore) DeleteAttachment(ctx context.Context, id string) error {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	_, err := s.pool.Exec(ctx, `DELETE FROM attachments WHERE id = $1`, id)
	if err != nil {
		return fmt.Errorf("delete attachment: %w", err)
	}
	return nil
}

func (s *MediaStore) ResetAttachmentToPending(ctx context.Context, id string) error {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	_, err := s.pool.Exec(ctx,
		`UPDATE attachments SET status = 'pending', expires_at = now() + interval '2 hours', updated_at = now()
		 WHERE id = $1 AND status = 'completed'`,
		id,
	)
	if err != nil {
		return fmt.Errorf("reset attachment to pending: %w", err)
	}
	return nil
}

func (s *MediaStore) FindOrphanedUploads(ctx context.Context, before time.Time, limit int) ([]*models.Attachment, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	rows, err := s.pool.Query(ctx,
		`SELECT `+attachmentColumns+`
		 FROM attachments
		 WHERE status IN ('pending', 'processing') AND expires_at IS NOT NULL AND expires_at < $1
		 ORDER BY created_at LIMIT $2`,
		before, limit,
	)
	if err != nil {
		return nil, fmt.Errorf("query orphaned uploads: %w", err)
	}
	defer rows.Close()

	var attachments []*models.Attachment
	for rows.Next() {
		var a models.Attachment
		if err := scanAttachment(rows, &a); err != nil {
			return nil, fmt.Errorf("scan orphaned upload: %w", err)
		}
		attachments = append(attachments, &a)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate orphaned uploads: %w", err)
	}
	return attachments, nil
}
