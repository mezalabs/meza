package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/mezalabs/meza/internal/models"
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

// LookupShadowUserID returns the local user ID for a federated shadow user
// identified by (homeServer, remoteUserID). Returns "", nil if not found.
func (s *FederationStore) LookupShadowUserID(ctx context.Context, homeServer, remoteUserID string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	var id string
	err := s.pool.QueryRow(ctx,
		`SELECT id FROM users WHERE home_server = $1 AND remote_user_id = $2 AND is_federated = true`,
		homeServer, remoteUserID,
	).Scan(&id)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", nil
		}
		return "", fmt.Errorf("lookup shadow user: %w", err)
	}
	return id, nil
}

// FederationJoinTx atomically upserts a shadow user, checks bans, and adds
// guild membership within a single PostgreSQL transaction. This prevents
// orphaned shadow users on partial failure and ensures idempotent re-join:
//
//   - Shadow user: ON CONFLICT (home_server, remote_user_id) refreshes
//     display_name and avatar_url so re-joins pick up profile changes.
//   - Ban check: after upsert (so we have the shadow user ID) and before
//     membership insert (to prevent banned users from rejoining via new invite).
//   - Member row: ON CONFLICT (user_id, server_id) refreshes joined_at
//     so a re-join after leave (or admin kick) is recorded correctly.
//
// Shadow user rows are never deleted (kept for message attribution).
func (s *FederationStore) FederationJoinTx(ctx context.Context, homeServer, remoteUserID, displayName, avatarURL, serverID string) (*models.User, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx)

	id := models.NewID()
	now := time.Now()
	username := shadowUsername(remoteUserID)

	// Step 1: Upsert shadow user — idempotent via partial unique index
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
		return nil, fmt.Errorf("upsert shadow user: %w", err)
	}

	// Step 2: Check ban inside transaction (prevents TOCTOU race with concurrent ban)
	var banned bool
	err = tx.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM bans WHERE server_id = $1 AND user_id = $2)`,
		serverID, u.ID,
	).Scan(&banned)
	if err != nil {
		return nil, fmt.Errorf("check ban: %w", err)
	}
	if banned {
		return nil, ErrBannedFromServer
	}

	// Step 3: Add guild membership — idempotent via PK (user_id, server_id).
	// On conflict (user already a member), refresh joined_at so a re-join
	// after leave or admin kick is properly timestamped.
	_, err = tx.Exec(ctx,
		`INSERT INTO members (user_id, server_id, joined_at) VALUES ($1, $2, $3)
		 ON CONFLICT (user_id, server_id) DO UPDATE SET joined_at = EXCLUDED.joined_at`,
		u.ID, serverID, now,
	)
	if err != nil {
		return nil, fmt.Errorf("add member: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit tx: %w", err)
	}

	return &u, nil
}

// ErrBannedFromServer is returned when a banned user tries to join via federation.
var ErrBannedFromServer = errors.New("user is banned from this server")

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
