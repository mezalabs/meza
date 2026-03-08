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

// FederationStore implements FederationStorer using PostgreSQL.
type FederationStore struct {
	pool *pgxpool.Pool
}

// NewFederationStore creates a new FederationStore backed by a pgxpool.Pool.
func NewFederationStore(pool *pgxpool.Pool) *FederationStore {
	return &FederationStore{pool: pool}
}

// shadowUsername generates a unique-ish username for a federated shadow user.
// It uses the last 8 characters of the remote user ID (the random portion of
// ULIDs) to avoid timestamp-based collisions in the first 8 characters.
func shadowUsername(remoteUserID string) string {
	n := min(len(remoteUserID), 8)
	suffix := remoteUserID[len(remoteUserID)-n:]
	return fmt.Sprintf("federated_%s", suffix)
}

func (s *FederationStore) IsFederatedUser(ctx context.Context, userID string) (bool, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	var isFederated bool
	err := s.pool.QueryRow(ctx,
		`SELECT is_federated FROM users WHERE id = $1`, userID,
	).Scan(&isFederated)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return false, nil
		}
		return false, fmt.Errorf("check federated user: %w", err)
	}
	return isFederated, nil
}

// FederationJoinTx atomically consumes an invite, upserts a shadow user, and
// adds guild membership within a single PostgreSQL transaction. This prevents
// orphaned shadow users on partial failure and ensures invite consumption is
// rolled back if the join fails:
//
//   - Invite: consumed atomically — if join fails, the invite use is not burned.
//   - Shadow user: ON CONFLICT (home_server, remote_user_id) refreshes
//     display_name and avatar_url so re-joins pick up profile changes.
//   - Member row: ON CONFLICT (user_id, server_id) refreshes joined_at
//     so a re-join after leave (or admin kick) is recorded correctly.
//
// Shadow user rows are never deleted (kept for message attribution).
// Returns the shadow user and the invite (with server_id) on success.
// Returns (nil, nil, nil) if the invite is invalid/expired/maxed.
func (s *FederationStore) FederationJoinTx(ctx context.Context, homeServer, remoteUserID, displayName, avatarURL, inviteCode string) (*models.User, *models.Invite, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, nil, fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx)

	// Step 1: Consume invite atomically within the transaction.
	// If the join fails later, the transaction rolls back and the invite use is not burned.
	var inv models.Invite
	err = tx.QueryRow(ctx,
		`UPDATE invites
		 SET use_count = use_count + 1
		 WHERE code = $1
		   AND revoked = false
		   AND (expires_at IS NULL OR expires_at > now())
		   AND (max_uses = 0 OR use_count < max_uses)
		 RETURNING code, server_id, creator_id, max_uses, use_count, expires_at, revoked, created_at`,
		inviteCode,
	).Scan(&inv.Code, &inv.ServerID, &inv.CreatorID, &inv.MaxUses, &inv.UseCount, &inv.ExpiresAt, &inv.Revoked, &inv.CreatedAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil, nil // invite invalid/expired/maxed
		}
		return nil, nil, fmt.Errorf("consume invite in tx: %w", err)
	}

	id := models.NewID()
	now := time.Now()
	username := shadowUsername(remoteUserID)

	// Step 2: Upsert shadow user — idempotent via partial unique index
	// idx_users_federated_identity ON (home_server, remote_user_id) WHERE is_federated = true.
	// On conflict the existing row's profile is refreshed; the RETURNING clause
	// always gives back the canonical row regardless of insert vs update.
	var u models.User
	err = tx.QueryRow(ctx,
		`INSERT INTO users (id, username, display_name, avatar_url, is_federated, home_server, remote_user_id, created_at)
		 VALUES ($1, $2, $3, $4, true, $5, $6, $7)
		 ON CONFLICT (home_server, remote_user_id) WHERE is_federated = true
		 DO UPDATE SET display_name = EXCLUDED.display_name, avatar_url = EXCLUDED.avatar_url, updated_at = now()
		 RETURNING id, username, COALESCE(display_name,''), COALESCE(avatar_url,''), is_federated, COALESCE(home_server,''), COALESCE(remote_user_id,''), created_at`,
		id, username, displayName, avatarURL, homeServer, remoteUserID, now,
	).Scan(&u.ID, &u.Username, &u.DisplayName, &u.AvatarURL, &u.IsFederated, &u.HomeServer, &u.RemoteUserID, &u.CreatedAt)
	if err != nil {
		return nil, nil, fmt.Errorf("upsert shadow user: %w", err)
	}

	// Step 3: Add guild membership — idempotent via PK (user_id, server_id).
	// On conflict (user already a member), refresh joined_at so a re-join
	// after leave or admin kick is properly timestamped.
	_, err = tx.Exec(ctx,
		`INSERT INTO members (user_id, server_id, joined_at) VALUES ($1, $2, $3)
		 ON CONFLICT (user_id, server_id) DO UPDATE SET joined_at = EXCLUDED.joined_at`,
		u.ID, inv.ServerID, now,
	)
	if err != nil {
		return nil, nil, fmt.Errorf("add member: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, nil, fmt.Errorf("commit tx: %w", err)
	}

	return &u, &inv, nil
}

// ErrShadowUserNotFound is returned when UpdateShadowUserProfile matches no rows.
var ErrShadowUserNotFound = errors.New("shadow user not found")

func (s *FederationStore) UpdateShadowUserProfile(ctx context.Context, userID, displayName, avatarURL string) error {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	result, err := s.pool.Exec(ctx,
		`UPDATE users SET display_name = $2, avatar_url = $3, updated_at = now()
		 WHERE id = $1 AND is_federated = true`,
		userID, displayName, avatarURL,
	)
	if err != nil {
		return fmt.Errorf("update shadow user profile: %w", err)
	}
	if result.RowsAffected() == 0 {
		return ErrShadowUserNotFound
	}
	return nil
}
