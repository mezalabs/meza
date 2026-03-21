package store

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/mezalabs/meza/internal/models"
)

// BotStore implements BotStorer using PostgreSQL.
type BotStore struct {
	pool *pgxpool.Pool
}

// NewBotStore creates a new BotStore backed by a pgxpool.Pool.
func NewBotStore(pool *pgxpool.Pool) *BotStore {
	return &BotStore{pool: pool}
}

// Pool returns the underlying connection pool (used by webhook service for bulk queries).
func (s *BotStore) Pool() *pgxpool.Pool {
	return s.pool
}

func (s *BotStore) CreateBotUser(ctx context.Context, user *models.User, signingPublicKey []byte) (*models.User, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	_, err := s.pool.Exec(ctx,
		`INSERT INTO users (id, email, username, display_name, avatar_url, is_bot, bot_owner_id, signing_public_key, created_at)
		 VALUES ($1, $2, $3, $4, $5, true, $6, $7, $8)`,
		user.ID, user.Email, user.Username, user.DisplayName, user.AvatarURL,
		user.BotOwnerID, signingPublicKey, user.CreatedAt,
	)
	if err != nil {
		return nil, fmt.Errorf("insert bot user: %w", err)
	}
	user.IsBot = true
	user.SigningPublicKey = signingPublicKey
	return user, nil
}

func (s *BotStore) CreateBotToken(ctx context.Context, token *models.BotToken) error {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	_, err := s.pool.Exec(ctx,
		`INSERT INTO bot_tokens (id, bot_user_id, token_hash, created_at)
		 VALUES ($1, $2, $3, $4)`,
		token.ID, token.BotUserID, token.TokenHash, token.CreatedAt,
	)
	if err != nil {
		return fmt.Errorf("insert bot token: %w", err)
	}
	return nil
}

func (s *BotStore) GetBotByTokenHash(ctx context.Context, tokenHash []byte) (*models.User, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	var u models.User
	err := s.pool.QueryRow(ctx,
		`SELECT u.id, COALESCE(u.email,''), u.username, COALESCE(u.display_name,''), COALESCE(u.avatar_url,''),
		        u.is_bot, COALESCE(u.bot_owner_id,''), u.created_at, u.signing_public_key
		 FROM users u
		 JOIN bot_tokens t ON t.bot_user_id = u.id
		 WHERE t.token_hash = $1 AND t.revoked = false`, tokenHash,
	).Scan(&u.ID, &u.Email, &u.Username, &u.DisplayName, &u.AvatarURL,
		&u.IsBot, &u.BotOwnerID, &u.CreatedAt, &u.SigningPublicKey)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, fmt.Errorf("query bot by token hash: %w", err)
	}
	return &u, nil
}

func (s *BotStore) RevokeBotTokens(ctx context.Context, botUserID string) error {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	_, err := s.pool.Exec(ctx,
		`UPDATE bot_tokens SET revoked = true WHERE bot_user_id = $1 AND revoked = false`,
		botUserID,
	)
	if err != nil {
		return fmt.Errorf("revoke bot tokens: %w", err)
	}
	return nil
}

func (s *BotStore) ListBotsByOwner(ctx context.Context, ownerID string) ([]*models.User, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	rows, err := s.pool.Query(ctx,
		`SELECT id, COALESCE(email,''), username, COALESCE(display_name,''), COALESCE(avatar_url,''),
		        is_bot, COALESCE(bot_owner_id,''), created_at
		 FROM users WHERE bot_owner_id = $1 AND is_bot = true
		 ORDER BY created_at DESC`, ownerID,
	)
	if err != nil {
		return nil, fmt.Errorf("list bots by owner: %w", err)
	}
	defer rows.Close()

	var bots []*models.User
	for rows.Next() {
		var u models.User
		if err := rows.Scan(&u.ID, &u.Email, &u.Username, &u.DisplayName, &u.AvatarURL,
			&u.IsBot, &u.BotOwnerID, &u.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan bot: %w", err)
		}
		bots = append(bots, &u)
	}
	return bots, rows.Err()
}

func (s *BotStore) CountBotsByOwner(ctx context.Context, ownerID string) (int, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	var count int
	err := s.pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM users WHERE bot_owner_id = $1 AND is_bot = true`, ownerID,
	).Scan(&count)
	if err != nil {
		return 0, fmt.Errorf("count bots by owner: %w", err)
	}
	return count, nil
}

func (s *BotStore) GetBotUser(ctx context.Context, botID string) (*models.User, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	var u models.User
	err := s.pool.QueryRow(ctx,
		`SELECT id, COALESCE(email,''), username, COALESCE(display_name,''), COALESCE(avatar_url,''),
		        is_bot, COALESCE(bot_owner_id,''), created_at, signing_public_key
		 FROM users WHERE id = $1 AND is_bot = true`, botID,
	).Scan(&u.ID, &u.Email, &u.Username, &u.DisplayName, &u.AvatarURL,
		&u.IsBot, &u.BotOwnerID, &u.CreatedAt, &u.SigningPublicKey)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, fmt.Errorf("get bot user: %w", err)
	}
	return &u, nil
}

func (s *BotStore) DeleteBotUser(ctx context.Context, botID string) error {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	tag, err := s.pool.Exec(ctx,
		`DELETE FROM users WHERE id = $1 AND is_bot = true`, botID,
	)
	if err != nil {
		return fmt.Errorf("delete bot user: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *BotStore) UpdateBotTokenLastUsed(ctx context.Context, tokenHash []byte) error {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	_, err := s.pool.Exec(ctx,
		`UPDATE bot_tokens SET last_used_at = now() WHERE token_hash = $1 AND revoked = false`,
		tokenHash,
	)
	if err != nil {
		return fmt.Errorf("update bot token last used: %w", err)
	}
	return nil
}

func (s *BotStore) CreateWebhook(ctx context.Context, webhook *models.BotWebhook) (*models.BotWebhook, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	_, err := s.pool.Exec(ctx,
		`INSERT INTO bot_webhooks (id, bot_user_id, server_id, url, secret, created_at)
		 VALUES ($1, $2, $3, $4, $5, $6)`,
		webhook.ID, webhook.BotUserID, webhook.ServerID, webhook.URL, webhook.Secret, webhook.CreatedAt,
	)
	if err != nil {
		return nil, fmt.Errorf("insert webhook: %w", err)
	}
	return webhook, nil
}

func (s *BotStore) DeleteWebhook(ctx context.Context, webhookID string) error {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	tag, err := s.pool.Exec(ctx,
		`DELETE FROM bot_webhooks WHERE id = $1`, webhookID,
	)
	if err != nil {
		return fmt.Errorf("delete webhook: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *BotStore) ListWebhooksByServer(ctx context.Context, serverID string) ([]*models.BotWebhook, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	rows, err := s.pool.Query(ctx,
		`SELECT id, bot_user_id, server_id, url, secret, created_at
		 FROM bot_webhooks WHERE server_id = $1
		 ORDER BY created_at DESC`, serverID,
	)
	if err != nil {
		return nil, fmt.Errorf("list webhooks by server: %w", err)
	}
	defer rows.Close()

	var webhooks []*models.BotWebhook
	for rows.Next() {
		var w models.BotWebhook
		if err := rows.Scan(&w.ID, &w.BotUserID, &w.ServerID, &w.URL, &w.Secret, &w.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan webhook: %w", err)
		}
		webhooks = append(webhooks, &w)
	}
	return webhooks, rows.Err()
}

func (s *BotStore) GetWebhooksForChannel(ctx context.Context, channelID string) ([]*models.BotWebhook, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	rows, err := s.pool.Query(ctx,
		`SELECT w.id, w.bot_user_id, w.server_id, w.url, w.secret, w.created_at
		 FROM bot_webhooks w
		 JOIN channels c ON c.server_id = w.server_id
		 WHERE c.id = $1`, channelID,
	)
	if err != nil {
		return nil, fmt.Errorf("get webhooks for channel: %w", err)
	}
	defer rows.Close()

	var webhooks []*models.BotWebhook
	for rows.Next() {
		var w models.BotWebhook
		if err := rows.Scan(&w.ID, &w.BotUserID, &w.ServerID, &w.URL, &w.Secret, &w.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan webhook: %w", err)
		}
		webhooks = append(webhooks, &w)
	}
	return webhooks, rows.Err()
}

func (s *BotStore) GetWebhook(ctx context.Context, webhookID string) (*models.BotWebhook, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	var w models.BotWebhook
	err := s.pool.QueryRow(ctx,
		`SELECT id, bot_user_id, server_id, url, secret, created_at
		 FROM bot_webhooks WHERE id = $1`, webhookID,
	).Scan(&w.ID, &w.BotUserID, &w.ServerID, &w.URL, &w.Secret, &w.CreatedAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, fmt.Errorf("get webhook: %w", err)
	}
	return &w, nil
}
