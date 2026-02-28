package store

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/meza-chat/meza/internal/models"
)

// ChannelGroupStore implements ChannelGroupStorer using PostgreSQL.
type ChannelGroupStore struct {
	pool *pgxpool.Pool
}

// NewChannelGroupStore creates a new ChannelGroupStore backed by a pgxpool.Pool.
func NewChannelGroupStore(pool *pgxpool.Pool) *ChannelGroupStore {
	return &ChannelGroupStore{pool: pool}
}

func (s *ChannelGroupStore) CreateChannelGroup(ctx context.Context, group *models.ChannelGroup) (*models.ChannelGroup, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	err := s.pool.QueryRow(ctx,
		`INSERT INTO channel_groups (id, server_id, name, position, created_at)
		 SELECT $1, $2, $3, COALESCE(MAX(position), -1) + 1, $4
		 FROM channel_groups WHERE server_id = $5
		 RETURNING id, server_id, name, position, created_at`,
		group.ID, group.ServerID, group.Name, group.CreatedAt, group.ServerID,
	).Scan(&group.ID, &group.ServerID, &group.Name, &group.Position, &group.CreatedAt)
	if err != nil {
		return nil, fmt.Errorf("insert channel group: %w", err)
	}
	return group, nil
}

func (s *ChannelGroupStore) GetChannelGroup(ctx context.Context, groupID string) (*models.ChannelGroup, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	var g models.ChannelGroup
	err := s.pool.QueryRow(ctx,
		`SELECT id, server_id, name, position, created_at FROM channel_groups WHERE id = $1`, groupID,
	).Scan(&g.ID, &g.ServerID, &g.Name, &g.Position, &g.CreatedAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, fmt.Errorf("channel group %w", ErrNotFound)
		}
		return nil, fmt.Errorf("query channel group: %w", err)
	}
	return &g, nil
}

func (s *ChannelGroupStore) ListChannelGroups(ctx context.Context, serverID string) ([]*models.ChannelGroup, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	rows, err := s.pool.Query(ctx,
		`SELECT id, server_id, name, position, created_at
		 FROM channel_groups WHERE server_id = $1 ORDER BY position`, serverID,
	)
	if err != nil {
		return nil, fmt.Errorf("query channel groups: %w", err)
	}
	defer rows.Close()

	var groups []*models.ChannelGroup
	for rows.Next() {
		var g models.ChannelGroup
		if err := rows.Scan(&g.ID, &g.ServerID, &g.Name, &g.Position, &g.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan channel group: %w", err)
		}
		groups = append(groups, &g)
	}
	return groups, rows.Err()
}

func (s *ChannelGroupStore) UpdateChannelGroup(ctx context.Context, groupID string, name *string, position *int) (*models.ChannelGroup, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	setClauses := []string{}
	args := []any{}
	argIdx := 1

	if name != nil {
		setClauses = append(setClauses, fmt.Sprintf("name = $%d", argIdx))
		args = append(args, *name)
		argIdx++
	}
	if position != nil {
		setClauses = append(setClauses, fmt.Sprintf("position = $%d", argIdx))
		args = append(args, *position)
		argIdx++
	}

	if len(setClauses) == 0 {
		return s.GetChannelGroup(ctx, groupID)
	}

	query := fmt.Sprintf(
		"UPDATE channel_groups SET %s WHERE id = $%d RETURNING id, server_id, name, position, created_at",
		strings.Join(setClauses, ", "),
		argIdx,
	)
	args = append(args, groupID)

	var g models.ChannelGroup
	err := s.pool.QueryRow(ctx, query, args...).Scan(
		&g.ID, &g.ServerID, &g.Name, &g.Position, &g.CreatedAt,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, fmt.Errorf("channel group %w", ErrNotFound)
		}
		return nil, fmt.Errorf("update channel group: %w", err)
	}
	return &g, nil
}

func (s *ChannelGroupStore) DeleteChannelGroup(ctx context.Context, groupID string) error {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	result, err := s.pool.Exec(ctx, `DELETE FROM channel_groups WHERE id = $1`, groupID)
	if err != nil {
		return fmt.Errorf("delete channel group: %w", err)
	}
	if result.RowsAffected() == 0 {
		return fmt.Errorf("channel group %w", ErrNotFound)
	}
	return nil
}
