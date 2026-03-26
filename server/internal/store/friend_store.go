package store

import (
	"context"
	"fmt"
	"hash/fnv"

	"github.com/mezalabs/meza/internal/models"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// maxFriendListResults is a hard cap on the number of rows returned by list
// queries (ListFriendsWithUsers, ListIncomingRequestsWithUsers, ListOutgoingRequestsWithUsers)
// to prevent unbounded result sets from degrading performance.
const maxFriendListResults = 200

// FriendStore implements FriendStorer using PostgreSQL.
type FriendStore struct {
	pool *pgxpool.Pool
}

// NewFriendStore creates a new FriendStore backed by a pgxpool.Pool.
func NewFriendStore(pool *pgxpool.Pool) *FriendStore {
	return &FriendStore{pool: pool}
}

// userColumns is the SELECT list for scanning a models.User from a JOIN query.
const userColumns = `u.id, COALESCE(u.email,''), u.username, COALESCE(u.display_name,''),
		COALESCE(u.avatar_url,''), u.emoji_scale, u.created_at,
		COALESCE(u.bio,''), COALESCE(u.pronouns,''), COALESCE(u.banner_url,''),
		COALESCE(u.theme_color_primary,''), COALESCE(u.theme_color_secondary,''),
		u.simple_mode, u.dm_privacy`

func scanUser(row pgx.Row) (*models.User, error) {
	var u models.User
	err := row.Scan(
		&u.ID, &u.Email, &u.Username, &u.DisplayName,
		&u.AvatarURL, &u.EmojiScale, &u.CreatedAt,
		&u.Bio, &u.Pronouns, &u.BannerURL,
		&u.ThemeColorPrimary, &u.ThemeColorSecondary,
		&u.SimpleMode, &u.DMPrivacy,
	)
	if err != nil {
		return nil, err
	}
	return &u, nil
}

func scanUserFromRows(rows pgx.Rows) (*models.User, error) {
	var u models.User
	err := rows.Scan(
		&u.ID, &u.Email, &u.Username, &u.DisplayName,
		&u.AvatarURL, &u.EmojiScale, &u.CreatedAt,
		&u.Bio, &u.Pronouns, &u.BannerURL,
		&u.ThemeColorPrimary, &u.ThemeColorSecondary,
		&u.SimpleMode, &u.DMPrivacy,
	)
	if err != nil {
		return nil, err
	}
	return &u, nil
}

// friendPairLockKey returns a deterministic int64 advisory-lock key for a pair
// of user IDs, regardless of order. Used to serialize concurrent friend
// operations between the same two users.
func friendPairLockKey(a, b string) int64 {
	if a > b {
		a, b = b, a
	}
	h := fnv.New64a()
	h.Write([]byte(a))
	h.Write([]byte{0})
	h.Write([]byte(b))
	return int64(h.Sum64())
}

// SendFriendRequest creates a pending friendship or auto-accepts if a reverse pending request exists.
// Uses advisory locking on the user pair to serialize concurrent mutual requests and prevent duplicates.
func (s *FriendStore) SendFriendRequest(ctx context.Context, requesterID, addresseeID string) (bool, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return false, fmt.Errorf("begin transaction: %w", err)
	}
	defer tx.Rollback(ctx)

	// Acquire an advisory lock on the sorted user pair to serialize concurrent
	// mutual friend requests. Without this, two concurrent requests between the
	// same pair can both miss each other's pending row and create duplicate
	// friendship rows (one in each direction).
	_, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock($1)", friendPairLockKey(requesterID, addresseeID))
	if err != nil {
		return false, fmt.Errorf("acquire advisory lock: %w", err)
	}

	// Check if already friends in either direction.
	var alreadyFriends bool
	err = tx.QueryRow(ctx,
		`SELECT EXISTS(
			SELECT 1 FROM friendships
			WHERE ((requester_id = $1 AND addressee_id = $2) OR (requester_id = $2 AND addressee_id = $1))
			  AND status = 'accepted'
		)`,
		requesterID, addresseeID,
	).Scan(&alreadyFriends)
	if err != nil {
		return false, fmt.Errorf("check existing friendship: %w", err)
	}
	if alreadyFriends {
		if err := tx.Commit(ctx); err != nil {
			return false, fmt.Errorf("commit already-friends: %w", err)
		}
		return true, nil
	}

	// Check for a reverse pending request.
	var reverseExists bool
	err = tx.QueryRow(ctx,
		`SELECT EXISTS(
			SELECT 1 FROM friendships
			WHERE requester_id = $1 AND addressee_id = $2 AND status = 'pending'
		)`,
		addresseeID, requesterID,
	).Scan(&reverseExists)
	if err != nil {
		return false, fmt.Errorf("check reverse request: %w", err)
	}

	if reverseExists {
		// Auto-accept: update the existing reverse row to accepted.
		_, err := tx.Exec(ctx,
			`UPDATE friendships SET status = 'accepted', accepted_at = now()
			 WHERE requester_id = $1 AND addressee_id = $2 AND status = 'pending'`,
			addresseeID, requesterID,
		)
		if err != nil {
			return false, fmt.Errorf("auto-accept reverse request: %w", err)
		}
		if err := tx.Commit(ctx); err != nil {
			return false, fmt.Errorf("commit auto-accept: %w", err)
		}
		return true, nil
	}

	// No reverse request — insert a new pending friendship.
	_, err = tx.Exec(ctx,
		`INSERT INTO friendships (requester_id, addressee_id, status)
		 VALUES ($1, $2, 'pending')
		 ON CONFLICT (requester_id, addressee_id) DO NOTHING`,
		requesterID, addresseeID,
	)
	if err != nil {
		return false, fmt.Errorf("insert friend request: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return false, fmt.Errorf("commit friend request: %w", err)
	}
	return false, nil
}

// AcceptFriendRequest moves a pending friendship to accepted.
func (s *FriendStore) AcceptFriendRequest(ctx context.Context, addresseeID, requesterID string) error {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	tag, err := s.pool.Exec(ctx,
		`UPDATE friendships SET status = 'accepted', accepted_at = now()
		 WHERE requester_id = $1 AND addressee_id = $2 AND status = 'pending'`,
		requesterID, addresseeID,
	)
	if err != nil {
		return fmt.Errorf("accept friend request: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("accept friend request: %w", ErrNotFound)
	}
	return nil
}

// DeclineFriendRequest deletes a pending friendship (allowing re-request).
func (s *FriendStore) DeclineFriendRequest(ctx context.Context, addresseeID, requesterID string) error {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	tag, err := s.pool.Exec(ctx,
		`DELETE FROM friendships WHERE requester_id = $1 AND addressee_id = $2 AND status = 'pending'`,
		requesterID, addresseeID,
	)
	if err != nil {
		return fmt.Errorf("decline friend request: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("decline friend request: %w", ErrNotFound)
	}
	return nil
}

// CancelFriendRequest deletes a pending outgoing friendship request.
func (s *FriendStore) CancelFriendRequest(ctx context.Context, requesterID, addresseeID string) error {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	tag, err := s.pool.Exec(ctx,
		`DELETE FROM friendships WHERE requester_id = $1 AND addressee_id = $2 AND status = 'pending'`,
		requesterID, addresseeID,
	)
	if err != nil {
		return fmt.Errorf("cancel friend request: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("cancel friend request: %w", ErrNotFound)
	}
	return nil
}

// RemoveFriend deletes an accepted friendship in either direction.
func (s *FriendStore) RemoveFriend(ctx context.Context, userA, userB string) error {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	tag, err := s.pool.Exec(ctx,
		`DELETE FROM friendships
		 WHERE ((requester_id = $1 AND addressee_id = $2) OR (requester_id = $2 AND addressee_id = $1))
		   AND status = 'accepted'`,
		userA, userB,
	)
	if err != nil {
		return fmt.Errorf("remove friend: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("remove friend: %w", ErrNotFound)
	}
	return nil
}

// AreFriends checks if two users have an accepted friendship in either direction.
func (s *FriendStore) AreFriends(ctx context.Context, userA, userB string) (bool, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	var exists bool
	err := s.pool.QueryRow(ctx,
		`SELECT EXISTS(
			SELECT 1 FROM friendships
			WHERE ((requester_id = $1 AND addressee_id = $2) OR (requester_id = $2 AND addressee_id = $1))
			  AND status = 'accepted'
		)`,
		userA, userB,
	).Scan(&exists)
	if err != nil {
		return false, fmt.Errorf("check friendship: %w", err)
	}
	return exists, nil
}

// ListFriendsWithUsers returns full user models for all accepted friends.
func (s *FriendStore) ListFriendsWithUsers(ctx context.Context, userID string) ([]*models.User, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	rows, err := s.pool.Query(ctx,
		fmt.Sprintf(`SELECT %s
		 FROM friendships f
		 JOIN users u ON u.id = CASE
			WHEN f.requester_id = $1 THEN f.addressee_id
			ELSE f.requester_id
		 END
		 WHERE (f.requester_id = $1 OR f.addressee_id = $1)
		   AND f.status = 'accepted'
		 ORDER BY f.accepted_at DESC
		 LIMIT %d`, userColumns, maxFriendListResults),
		userID,
	)
	if err != nil {
		return nil, fmt.Errorf("query friends: %w", err)
	}
	defer rows.Close()

	var users []*models.User
	seen := make(map[string]bool)
	for rows.Next() {
		u, err := scanUserFromRows(rows)
		if err != nil {
			return nil, fmt.Errorf("scan friend: %w", err)
		}
		if seen[u.ID] {
			continue
		}
		seen[u.ID] = true
		users = append(users, u)
	}
	return users, rows.Err()
}

// ListIncomingRequestsWithUsers returns pending requests where the user is the addressee.
func (s *FriendStore) ListIncomingRequestsWithUsers(ctx context.Context, userID string) ([]*models.FriendRequest, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	rows, err := s.pool.Query(ctx,
		fmt.Sprintf(`SELECT %s, f.created_at
		 FROM friendships f
		 JOIN users u ON u.id = f.requester_id
		 WHERE f.addressee_id = $1 AND f.status = 'pending'
		 ORDER BY f.created_at DESC
		 LIMIT %d`, userColumns, maxFriendListResults),
		userID,
	)
	if err != nil {
		return nil, fmt.Errorf("query incoming requests: %w", err)
	}
	defer rows.Close()

	var requests []*models.FriendRequest
	for rows.Next() {
		var u models.User
		var fr models.FriendRequest
		if err := rows.Scan(
			&u.ID, &u.Email, &u.Username, &u.DisplayName,
			&u.AvatarURL, &u.EmojiScale, &u.CreatedAt,
			&u.Bio, &u.Pronouns, &u.BannerURL,
			&u.ThemeColorPrimary, &u.ThemeColorSecondary,
			&u.SimpleMode, &u.DMPrivacy,
			&fr.CreatedAt,
		); err != nil {
			return nil, fmt.Errorf("scan incoming request: %w", err)
		}
		fr.User = &u
		fr.Direction = "incoming"
		requests = append(requests, &fr)
	}
	return requests, rows.Err()
}

// ListOutgoingRequestsWithUsers returns pending requests where the user is the requester.
func (s *FriendStore) ListOutgoingRequestsWithUsers(ctx context.Context, userID string) ([]*models.FriendRequest, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	rows, err := s.pool.Query(ctx,
		fmt.Sprintf(`SELECT %s, f.created_at
		 FROM friendships f
		 JOIN users u ON u.id = f.addressee_id
		 WHERE f.requester_id = $1 AND f.status = 'pending'
		 ORDER BY f.created_at DESC
		 LIMIT %d`, userColumns, maxFriendListResults),
		userID,
	)
	if err != nil {
		return nil, fmt.Errorf("query outgoing requests: %w", err)
	}
	defer rows.Close()

	var requests []*models.FriendRequest
	for rows.Next() {
		var u models.User
		var fr models.FriendRequest
		if err := rows.Scan(
			&u.ID, &u.Email, &u.Username, &u.DisplayName,
			&u.AvatarURL, &u.EmojiScale, &u.CreatedAt,
			&u.Bio, &u.Pronouns, &u.BannerURL,
			&u.ThemeColorPrimary, &u.ThemeColorSecondary,
			&u.SimpleMode, &u.DMPrivacy,
			&fr.CreatedAt,
		); err != nil {
			return nil, fmt.Errorf("scan outgoing request: %w", err)
		}
		fr.User = &u
		fr.Direction = "outgoing"
		requests = append(requests, &fr)
	}
	return requests, rows.Err()
}

// CountPendingOutgoingRequests returns the number of pending outgoing friend requests for a user.
func (s *FriendStore) CountPendingOutgoingRequests(ctx context.Context, userID string) (int, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	var count int
	err := s.pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM friendships WHERE requester_id = $1 AND status = 'pending'`,
		userID,
	).Scan(&count)
	if err != nil {
		return 0, fmt.Errorf("count pending outgoing requests: %w", err)
	}
	return count, nil
}

// RemoveFriendshipsByUser deletes any friendship (pending or accepted) between two users.
// Used by BlockUser to clean up friendships on block.
func (s *FriendStore) RemoveFriendshipsByUser(ctx context.Context, userID, otherID string) error {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	_, err := s.pool.Exec(ctx,
		`DELETE FROM friendships
		 WHERE (requester_id = $1 AND addressee_id = $2) OR (requester_id = $2 AND addressee_id = $1)`,
		userID, otherID,
	)
	if err != nil {
		return fmt.Errorf("remove friendships by user: %w", err)
	}
	return nil
}

// RemoveFriendshipsByUserTx deletes any friendship (pending or accepted) between two users
// within an existing transaction.
func (s *FriendStore) RemoveFriendshipsByUserTx(ctx context.Context, tx pgx.Tx, userID, otherID string) error {
	_, err := tx.Exec(ctx,
		`DELETE FROM friendships
		 WHERE (requester_id = $1 AND addressee_id = $2) OR (requester_id = $2 AND addressee_id = $1)`,
		userID, otherID,
	)
	if err != nil {
		return fmt.Errorf("remove friendships by user: %w", err)
	}
	return nil
}

// GetMutualFriends returns users who are friends with both userID1 and userID2.
func (s *FriendStore) GetMutualFriends(ctx context.Context, userID1, userID2 string) ([]*models.User, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	rows, err := s.pool.Query(ctx,
		fmt.Sprintf(`SELECT %s
		 FROM users u
		 JOIN friendships f1 ON (
			(f1.requester_id = $1 AND f1.addressee_id = u.id) OR
			(f1.addressee_id = $1 AND f1.requester_id = u.id)
		 ) AND f1.status = 'accepted'
		 JOIN friendships f2 ON (
			(f2.requester_id = $2 AND f2.addressee_id = u.id) OR
			(f2.addressee_id = $2 AND f2.requester_id = u.id)
		 ) AND f2.status = 'accepted'
		 ORDER BY u.username
		 LIMIT 50`, userColumns),
		userID1, userID2,
	)
	if err != nil {
		return nil, fmt.Errorf("query mutual friends: %w", err)
	}
	defer rows.Close()

	var users []*models.User
	for rows.Next() {
		u, err := scanUserFromRows(rows)
		if err != nil {
			return nil, fmt.Errorf("scan mutual friend: %w", err)
		}
		users = append(users, u)
	}
	return users, rows.Err()
}
