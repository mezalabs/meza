package store

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/meza-chat/meza/internal/models"
)

const (
	inviteCodeLength  = 8
	inviteCodeCharset = "0123456789abcdefghijklmnopqrstuvwxyz"
)

// InviteStore implements InviteStorer using PostgreSQL.
type InviteStore struct {
	pool *pgxpool.Pool
}

// NewInviteStore creates a new InviteStore backed by a pgxpool.Pool.
func NewInviteStore(pool *pgxpool.Pool) *InviteStore {
	return &InviteStore{pool: pool}
}

func generateInviteCode() (string, error) {
	const charsetLen = byte(len(inviteCodeCharset))
	// Largest multiple of charsetLen that fits in a byte, used to reject
	// values that would introduce modulo bias.
	const maxValid = 256 - (256 % int(charsetLen)) // 252

	code := make([]byte, inviteCodeLength)
	var b [1]byte
	for i := 0; i < inviteCodeLength; {
		if _, err := io.ReadFull(rand.Reader, b[:]); err != nil {
			return "", err
		}
		if int(b[0]) < maxValid {
			code[i] = inviteCodeCharset[b[0]%charsetLen]
			i++
		}
	}
	return string(code), nil
}

func (s *InviteStore) CreateInvite(ctx context.Context, serverID, creatorID string, maxUses int, expiresAt *time.Time, encryptedChannelKeys, channelKeysIV []byte) (*models.Invite, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	// Try up to 2 times to handle rare code collisions.
	for attempt := 0; attempt < 2; attempt++ {
		code, err := generateInviteCode()
		if err != nil {
			return nil, fmt.Errorf("generate invite code: %w", err)
		}

		now := time.Now()
		_, err = s.pool.Exec(ctx,
			`INSERT INTO invites (code, server_id, creator_id, max_uses, expires_at, created_at, encrypted_channel_keys, channel_keys_iv)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
			code, serverID, creatorID, maxUses, expiresAt, now, encryptedChannelKeys, channelKeysIV,
		)
		if err != nil {
			// Retry only on unique constraint violation (code collision).
			var pgErr *pgconn.PgError
			if attempt == 0 && errors.As(err, &pgErr) && pgErr.Code == "23505" {
				continue
			}
			return nil, fmt.Errorf("insert invite: %w", err)
		}

		return &models.Invite{
			Code:                 code,
			ServerID:             serverID,
			CreatorID:            creatorID,
			MaxUses:              maxUses,
			ExpiresAt:            expiresAt,
			CreatedAt:            now,
			EncryptedChannelKeys: encryptedChannelKeys,
			ChannelKeysIV:        channelKeysIV,
		}, nil
	}

	return nil, fmt.Errorf("failed to generate unique invite code")
}

func (s *InviteStore) GetInvite(ctx context.Context, code string) (*models.Invite, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	var inv models.Invite
	err := s.pool.QueryRow(ctx,
		`SELECT code, server_id, creator_id, max_uses, use_count, expires_at, revoked, created_at, encrypted_channel_keys, channel_keys_iv
		 FROM invites WHERE code = $1`, code,
	).Scan(&inv.Code, &inv.ServerID, &inv.CreatorID, &inv.MaxUses, &inv.UseCount, &inv.ExpiresAt, &inv.Revoked, &inv.CreatedAt, &inv.EncryptedChannelKeys, &inv.ChannelKeysIV)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, fmt.Errorf("invite not found")
		}
		return nil, fmt.Errorf("query invite: %w", err)
	}
	return &inv, nil
}

func (s *InviteStore) ConsumeInvite(ctx context.Context, code string) (*models.Invite, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	var inv models.Invite
	err := s.pool.QueryRow(ctx,
		`UPDATE invites
		 SET use_count = use_count + 1
		 WHERE code = $1
		   AND revoked = false
		   AND (expires_at IS NULL OR expires_at > now())
		   AND (max_uses = 0 OR use_count < max_uses)
		 RETURNING code, server_id, creator_id, max_uses, use_count, expires_at, revoked, created_at, encrypted_channel_keys, channel_keys_iv`,
		code,
	).Scan(&inv.Code, &inv.ServerID, &inv.CreatorID, &inv.MaxUses, &inv.UseCount, &inv.ExpiresAt, &inv.Revoked, &inv.CreatedAt, &inv.EncryptedChannelKeys, &inv.ChannelKeysIV)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil // invite invalid/expired/maxed — not an error, just nil
		}
		return nil, fmt.Errorf("consume invite: %w", err)
	}
	return &inv, nil
}

func (s *InviteStore) RevokeInvite(ctx context.Context, code string) error {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	_, err := s.pool.Exec(ctx,
		`UPDATE invites SET revoked = true WHERE code = $1`, code,
	)
	if err != nil {
		return fmt.Errorf("revoke invite: %w", err)
	}
	return nil
}

func (s *InviteStore) ListInvites(ctx context.Context, serverID string) ([]*models.Invite, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	rows, err := s.pool.Query(ctx,
		`SELECT code, server_id, creator_id, max_uses, use_count, expires_at, revoked, created_at, encrypted_channel_keys, channel_keys_iv
		 FROM invites WHERE server_id = $1
		 ORDER BY created_at DESC
		 LIMIT 100`, serverID,
	)
	if err != nil {
		return nil, fmt.Errorf("query invites: %w", err)
	}
	defer rows.Close()

	var invites []*models.Invite
	for rows.Next() {
		var inv models.Invite
		if err := rows.Scan(&inv.Code, &inv.ServerID, &inv.CreatorID, &inv.MaxUses, &inv.UseCount, &inv.ExpiresAt, &inv.Revoked, &inv.CreatedAt, &inv.EncryptedChannelKeys, &inv.ChannelKeysIV); err != nil {
			return nil, fmt.Errorf("scan invite: %w", err)
		}
		invites = append(invites, &inv)
	}
	return invites, nil
}
