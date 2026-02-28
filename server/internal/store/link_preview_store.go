package store

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/meza-chat/meza/internal/models"
)

// LinkPreviewStore implements LinkPreviewStorer using PostgreSQL.
type LinkPreviewStore struct {
	pool *pgxpool.Pool
}

// NewLinkPreviewStore creates a new LinkPreviewStore backed by a pgxpool.Pool.
func NewLinkPreviewStore(pool *pgxpool.Pool) *LinkPreviewStore {
	return &LinkPreviewStore{pool: pool}
}

func (s *LinkPreviewStore) UpsertLinkPreview(ctx context.Context, lp *models.LinkPreview) error {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	_, err := s.pool.Exec(ctx,
		`INSERT INTO link_previews (url_hash, url, title, description, site_name, image_key, image_width, image_height, favicon_key, og_type, fetched_at, expires_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
		 ON CONFLICT (url_hash) DO UPDATE SET
		   title = EXCLUDED.title,
		   description = EXCLUDED.description,
		   site_name = EXCLUDED.site_name,
		   image_key = EXCLUDED.image_key,
		   image_width = EXCLUDED.image_width,
		   image_height = EXCLUDED.image_height,
		   favicon_key = EXCLUDED.favicon_key,
		   og_type = EXCLUDED.og_type,
		   fetched_at = EXCLUDED.fetched_at,
		   expires_at = EXCLUDED.expires_at`,
		lp.URLHash, lp.URL, lp.Title, lp.Description, lp.SiteName,
		lp.ImageKey, lp.ImageWidth, lp.ImageHeight, lp.FaviconKey,
		lp.OGType, lp.FetchedAt, lp.ExpiresAt,
	)
	if err != nil {
		return fmt.Errorf("upsert link preview: %w", err)
	}
	return nil
}

func (s *LinkPreviewStore) GetLinkPreviewsByHashes(ctx context.Context, urlHashes []string) (map[string]*models.LinkPreview, error) {
	if len(urlHashes) == 0 {
		return map[string]*models.LinkPreview{}, nil
	}

	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	rows, err := s.pool.Query(ctx,
		`SELECT url_hash, url, title, description, site_name, image_key, image_width, image_height, favicon_key, og_type, fetched_at, expires_at
		 FROM link_previews WHERE url_hash = ANY($1)`,
		urlHashes,
	)
	if err != nil {
		return nil, fmt.Errorf("query link previews: %w", err)
	}
	defer rows.Close()

	result := make(map[string]*models.LinkPreview, len(urlHashes))
	for rows.Next() {
		var lp models.LinkPreview
		if err := rows.Scan(
			&lp.URLHash, &lp.URL, &lp.Title, &lp.Description, &lp.SiteName,
			&lp.ImageKey, &lp.ImageWidth, &lp.ImageHeight, &lp.FaviconKey,
			&lp.OGType, &lp.FetchedAt, &lp.ExpiresAt,
		); err != nil {
			return nil, fmt.Errorf("scan link preview: %w", err)
		}
		result[lp.URLHash] = &lp
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate link previews: %w", err)
	}
	return result, nil
}

func (s *LinkPreviewStore) SetMessageEmbeds(ctx context.Context, channelID, messageID string, urlHashes []string) error {
	if len(urlHashes) == 0 {
		return nil
	}

	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx)

	for i, urlHash := range urlHashes {
		_, err := tx.Exec(ctx,
			`INSERT INTO message_link_previews (channel_id, message_id, url_hash, position)
			 VALUES ($1, $2, $3, $4)
			 ON CONFLICT (channel_id, message_id, url_hash) DO UPDATE SET position = $4`,
			channelID, messageID, urlHash, i,
		)
		if err != nil {
			return fmt.Errorf("insert message link preview: %w", err)
		}
	}

	return tx.Commit(ctx)
}

func (s *LinkPreviewStore) DeleteMessageEmbeds(ctx context.Context, channelID, messageID string) error {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	_, err := s.pool.Exec(ctx,
		`DELETE FROM message_link_previews WHERE channel_id = $1 AND message_id = $2`,
		channelID, messageID,
	)
	if err != nil {
		return fmt.Errorf("delete message embeds: %w", err)
	}
	return nil
}

func (s *LinkPreviewStore) BulkDeleteMessageEmbeds(ctx context.Context, channelID string, messageIDs []string) error {
	if len(messageIDs) == 0 {
		return nil
	}

	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	_, err := s.pool.Exec(ctx,
		`DELETE FROM message_link_previews WHERE channel_id = $1 AND message_id = ANY($2)`,
		channelID, messageIDs,
	)
	if err != nil {
		return fmt.Errorf("bulk delete message embeds: %w", err)
	}
	return nil
}

// GetEmbedsForMessages returns link previews for a set of messages, keyed by message ID.
func (s *LinkPreviewStore) GetEmbedsForMessages(ctx context.Context, channelID string, messageIDs []string) (map[string][]*models.LinkPreview, error) {
	if len(messageIDs) == 0 {
		return map[string][]*models.LinkPreview{}, nil
	}

	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	rows, err := s.pool.Query(ctx,
		`SELECT mlp.message_id, lp.url_hash, lp.url, lp.title, lp.description, lp.site_name,
		        lp.image_key, lp.image_width, lp.image_height, lp.favicon_key, lp.og_type,
		        lp.fetched_at, lp.expires_at
		 FROM message_link_previews mlp
		 JOIN link_previews lp ON lp.url_hash = mlp.url_hash
		 WHERE mlp.channel_id = $1 AND mlp.message_id = ANY($2)
		 ORDER BY mlp.message_id, mlp.position`,
		channelID, messageIDs,
	)
	if err != nil {
		return nil, fmt.Errorf("query embeds for messages: %w", err)
	}
	defer rows.Close()

	result := make(map[string][]*models.LinkPreview)
	for rows.Next() {
		var messageID string
		var lp models.LinkPreview
		if err := rows.Scan(
			&messageID,
			&lp.URLHash, &lp.URL, &lp.Title, &lp.Description, &lp.SiteName,
			&lp.ImageKey, &lp.ImageWidth, &lp.ImageHeight, &lp.FaviconKey,
			&lp.OGType, &lp.FetchedAt, &lp.ExpiresAt,
		); err != nil {
			return nil, fmt.Errorf("scan embed: %w", err)
		}
		result[messageID] = append(result[messageID], &lp)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate embeds: %w", err)
	}
	return result, nil
}
