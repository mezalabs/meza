package store

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"fmt"
	"io"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/mezalabs/meza/internal/models"
)

const (
	webhookTokenLength  = 48
	webhookTokenCharset = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
)

// WebhookStore implements WebhookStorer using PostgreSQL.
type WebhookStore struct {
	pool *pgxpool.Pool
}

// NewWebhookStore creates a new WebhookStore backed by a pgxpool.Pool.
func NewWebhookStore(pool *pgxpool.Pool) *WebhookStore {
	return &WebhookStore{pool: pool}
}

// GenerateWebhookToken generates a cryptographically random token and its SHA-256 hash.
// Returns (rawToken, hash, error). The raw token is returned to the caller once; only the hash is stored.
func GenerateWebhookToken() (string, []byte, error) {
	const charsetLen = byte(len(webhookTokenCharset))
	const maxValid = 256 - (256 % int(charsetLen))

	token := make([]byte, webhookTokenLength)
	var b [1]byte
	for i := 0; i < webhookTokenLength; {
		if _, err := io.ReadFull(rand.Reader, b[:]); err != nil {
			return "", nil, err
		}
		if int(b[0]) < maxValid {
			token[i] = webhookTokenCharset[b[0]%charsetLen]
			i++
		}
	}

	hash := sha256.Sum256(token)
	return string(token), hash[:], nil
}

// HashWebhookToken returns the SHA-256 hash of a raw token string.
func HashWebhookToken(token string) []byte {
	hash := sha256.Sum256([]byte(token))
	return hash[:]
}

func (s *WebhookStore) CreateWebhook(ctx context.Context, webhook *models.Webhook) error {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	_, err := s.pool.Exec(ctx,
		`INSERT INTO webhooks (id, channel_id, server_id, name, avatar_url, token_hash, created_by, created_at, updated_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
		webhook.ID, webhook.ChannelID, webhook.ServerID, webhook.Name, webhook.AvatarURL,
		webhook.TokenHash, webhook.CreatedBy, webhook.CreatedAt, webhook.UpdatedAt,
	)
	if err != nil {
		return fmt.Errorf("insert webhook: %w", err)
	}
	return nil
}

func (s *WebhookStore) GetWebhook(ctx context.Context, webhookID string) (*models.Webhook, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	var w models.Webhook
	err := s.pool.QueryRow(ctx,
		`SELECT id, channel_id, server_id, name, avatar_url, created_by, created_at, updated_at
		 FROM webhooks WHERE id = $1`, webhookID,
	).Scan(&w.ID, &w.ChannelID, &w.ServerID, &w.Name, &w.AvatarURL, &w.CreatedBy, &w.CreatedAt, &w.UpdatedAt)
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil, ErrNotFound
		}
		return nil, fmt.Errorf("get webhook: %w", err)
	}
	return &w, nil
}

// GetWebhookWithToken returns the webhook including its token hash (for validation).
func (s *WebhookStore) GetWebhookWithToken(ctx context.Context, webhookID string) (*models.Webhook, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	var w models.Webhook
	err := s.pool.QueryRow(ctx,
		`SELECT id, channel_id, server_id, name, avatar_url, token_hash, created_by, created_at, updated_at
		 FROM webhooks WHERE id = $1`, webhookID,
	).Scan(&w.ID, &w.ChannelID, &w.ServerID, &w.Name, &w.AvatarURL, &w.TokenHash, &w.CreatedBy, &w.CreatedAt, &w.UpdatedAt)
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil, ErrNotFound
		}
		return nil, fmt.Errorf("get webhook with token: %w", err)
	}
	return &w, nil
}

func (s *WebhookStore) UpdateWebhook(ctx context.Context, webhookID string, name, avatarURL *string) (*models.Webhook, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	var w models.Webhook
	err := s.pool.QueryRow(ctx,
		`UPDATE webhooks SET
			name = COALESCE($2, name),
			avatar_url = COALESCE($3, avatar_url),
			updated_at = now()
		 WHERE id = $1
		 RETURNING id, channel_id, server_id, name, avatar_url, created_by, created_at, updated_at`,
		webhookID, name, avatarURL,
	).Scan(&w.ID, &w.ChannelID, &w.ServerID, &w.Name, &w.AvatarURL, &w.CreatedBy, &w.CreatedAt, &w.UpdatedAt)
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil, ErrNotFound
		}
		return nil, fmt.Errorf("update webhook: %w", err)
	}
	return &w, nil
}

func (s *WebhookStore) DeleteWebhook(ctx context.Context, webhookID string) error {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	tag, err := s.pool.Exec(ctx, `DELETE FROM webhooks WHERE id = $1`, webhookID)
	if err != nil {
		return fmt.Errorf("delete webhook: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *WebhookStore) ListByChannel(ctx context.Context, channelID string) ([]*models.Webhook, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	rows, err := s.pool.Query(ctx,
		`SELECT id, channel_id, server_id, name, avatar_url, created_by, created_at, updated_at
		 FROM webhooks WHERE channel_id = $1 ORDER BY created_at`, channelID,
	)
	if err != nil {
		return nil, fmt.Errorf("list webhooks by channel: %w", err)
	}
	defer rows.Close()

	return scanWebhooks(rows)
}

func (s *WebhookStore) ListByServer(ctx context.Context, serverID string) ([]*models.Webhook, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	rows, err := s.pool.Query(ctx,
		`SELECT id, channel_id, server_id, name, avatar_url, created_by, created_at, updated_at
		 FROM webhooks WHERE server_id = $1 ORDER BY created_at`, serverID,
	)
	if err != nil {
		return nil, fmt.Errorf("list webhooks by server: %w", err)
	}
	defer rows.Close()

	return scanWebhooks(rows)
}

func (s *WebhookStore) UpdateTokenHash(ctx context.Context, webhookID string, newHash []byte) error {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	tag, err := s.pool.Exec(ctx,
		`UPDATE webhooks SET token_hash = $2, updated_at = now() WHERE id = $1`,
		webhookID, newHash,
	)
	if err != nil {
		return fmt.Errorf("update token hash: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *WebhookStore) CountByChannel(ctx context.Context, channelID string) (int, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	var count int
	err := s.pool.QueryRow(ctx, `SELECT COUNT(*) FROM webhooks WHERE channel_id = $1`, channelID).Scan(&count)
	if err != nil {
		return 0, fmt.Errorf("count webhooks by channel: %w", err)
	}
	return count, nil
}

func (s *WebhookStore) CountByServer(ctx context.Context, serverID string) (int, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	var count int
	err := s.pool.QueryRow(ctx, `SELECT COUNT(*) FROM webhooks WHERE server_id = $1`, serverID).Scan(&count)
	if err != nil {
		return 0, fmt.Errorf("count webhooks by server: %w", err)
	}
	return count, nil
}

func (s *WebhookStore) InsertDelivery(ctx context.Context, delivery *models.WebhookDelivery) error {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	_, err := s.pool.Exec(ctx,
		`INSERT INTO webhook_deliveries (id, webhook_id, success, error_code, request_body_preview, message_id, source_ip, latency_ms, created_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
		delivery.ID, delivery.WebhookID, delivery.Success, delivery.ErrorCode,
		delivery.RequestBodyPreview, delivery.MessageID, delivery.SourceIP, delivery.LatencyMs, delivery.CreatedAt,
	)
	if err != nil {
		return fmt.Errorf("insert webhook delivery: %w", err)
	}
	return nil
}

func (s *WebhookStore) ListDeliveries(ctx context.Context, webhookID string, limit int) ([]*models.WebhookDelivery, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	if limit <= 0 || limit > 25 {
		limit = 25
	}

	rows, err := s.pool.Query(ctx,
		`SELECT id, webhook_id, success, error_code, request_body_preview, message_id, source_ip, latency_ms, created_at
		 FROM webhook_deliveries WHERE webhook_id = $1 ORDER BY created_at DESC LIMIT $2`,
		webhookID, limit,
	)
	if err != nil {
		return nil, fmt.Errorf("list webhook deliveries: %w", err)
	}
	defer rows.Close()

	var deliveries []*models.WebhookDelivery
	for rows.Next() {
		var d models.WebhookDelivery
		if err := rows.Scan(&d.ID, &d.WebhookID, &d.Success, &d.ErrorCode, &d.RequestBodyPreview,
			&d.MessageID, &d.SourceIP, &d.LatencyMs, &d.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan webhook delivery: %w", err)
		}
		deliveries = append(deliveries, &d)
	}
	return deliveries, rows.Err()
}

func (s *WebhookStore) CleanupOldDeliveries(ctx context.Context, webhookID string, keepCount int) error {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	_, err := s.pool.Exec(ctx,
		`DELETE FROM webhook_deliveries
		 WHERE webhook_id = $1
		   AND id NOT IN (
		     SELECT id FROM webhook_deliveries
		     WHERE webhook_id = $1
		     ORDER BY created_at DESC
		     LIMIT $2
		   )`,
		webhookID, keepCount,
	)
	if err != nil {
		return fmt.Errorf("cleanup old deliveries: %w", err)
	}
	return nil
}

func scanWebhooks(rows pgx.Rows) ([]*models.Webhook, error) {
	var webhooks []*models.Webhook
	for rows.Next() {
		var w models.Webhook
		if err := rows.Scan(&w.ID, &w.ChannelID, &w.ServerID, &w.Name, &w.AvatarURL,
			&w.CreatedBy, &w.CreatedAt, &w.UpdatedAt); err != nil {
			return nil, fmt.Errorf("scan webhook: %w", err)
		}
		webhooks = append(webhooks, &w)
	}
	return webhooks, rows.Err()
}
