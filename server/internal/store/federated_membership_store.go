package store

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
)

// FederatedMembershipStore implements FederatedMembershipStorer using PostgreSQL.
type FederatedMembershipStore struct {
	pool *pgxpool.Pool
}

// NewFederatedMembershipStore creates a new FederatedMembershipStore backed by a pgxpool.Pool.
func NewFederatedMembershipStore(pool *pgxpool.Pool) *FederatedMembershipStore {
	return &FederatedMembershipStore{pool: pool}
}

// AddFederatedMembership records a user's membership in a remote federated server.
// Idempotent: ON CONFLICT DO NOTHING avoids errors on duplicate inserts.
func (s *FederatedMembershipStore) AddFederatedMembership(ctx context.Context, userID, satelliteURL, serverID string) error {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	_, err := s.pool.Exec(ctx,
		`INSERT INTO federated_memberships (user_id, satellite_url, server_id)
		 VALUES ($1, $2, $3)
		 ON CONFLICT DO NOTHING`,
		userID, satelliteURL, serverID,
	)
	if err != nil {
		return fmt.Errorf("add federated membership: %w", err)
	}
	return nil
}

// RemoveFederatedMembership removes a user's membership in a remote federated server.
func (s *FederatedMembershipStore) RemoveFederatedMembership(ctx context.Context, userID, satelliteURL, serverID string) error {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	_, err := s.pool.Exec(ctx,
		`DELETE FROM federated_memberships
		 WHERE user_id = $1 AND satellite_url = $2 AND server_id = $3`,
		userID, satelliteURL, serverID,
	)
	if err != nil {
		return fmt.Errorf("remove federated membership: %w", err)
	}
	return nil
}

// ListFederatedMemberships returns all federated memberships for a user, ordered by join time.
func (s *FederatedMembershipStore) ListFederatedMemberships(ctx context.Context, userID string) ([]FederatedMembership, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	rows, err := s.pool.Query(ctx,
		`SELECT user_id, satellite_url, server_id, joined_at
		 FROM federated_memberships
		 WHERE user_id = $1
		 ORDER BY joined_at`,
		userID,
	)
	if err != nil {
		return nil, fmt.Errorf("list federated memberships: %w", err)
	}
	defer rows.Close()

	var memberships []FederatedMembership
	for rows.Next() {
		var m FederatedMembership
		if err := rows.Scan(&m.UserID, &m.SatelliteURL, &m.ServerID, &m.JoinedAt); err != nil {
			return nil, fmt.Errorf("scan federated membership: %w", err)
		}
		memberships = append(memberships, m)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate federated memberships: %w", err)
	}
	return memberships, nil
}
