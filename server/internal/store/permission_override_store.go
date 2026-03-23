package store

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/mezalabs/meza/internal/models"
	"github.com/mezalabs/meza/internal/permissions"
)

// PermissionOverrideStore implements PermissionOverrideStorer using PostgreSQL.
type PermissionOverrideStore struct {
	pool *pgxpool.Pool
}

// NewPermissionOverrideStore creates a new PermissionOverrideStore backed by a pgxpool.Pool.
func NewPermissionOverrideStore(pool *pgxpool.Pool) *PermissionOverrideStore {
	return &PermissionOverrideStore{pool: pool}
}

func (s *PermissionOverrideStore) SetOverride(ctx context.Context, override *models.PermissionOverride) (*models.PermissionOverride, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	var channelGroupID, channelID *string
	if override.ChannelGroupID != "" {
		channelGroupID = &override.ChannelGroupID
	}
	if override.ChannelID != "" {
		channelID = &override.ChannelID
	}

	// User overrides use user_id instead of role_id.
	isUserOverride := override.UserID != ""

	var roleID, userID *string
	if override.RoleID != "" {
		roleID = &override.RoleID
	}
	if override.UserID != "" {
		userID = &override.UserID
	}

	// Determine the correct conflict target based on override type and scope.
	// Partial unique indexes require column-based ON CONFLICT with matching WHERE clauses.
	var conflictClause string
	if isUserOverride {
		if channelGroupID != nil {
			conflictClause = "(channel_group_id, user_id) WHERE channel_group_id IS NOT NULL AND user_id IS NOT NULL"
		} else {
			conflictClause = "(channel_id, user_id) WHERE channel_id IS NOT NULL AND user_id IS NOT NULL"
		}
	} else {
		if channelGroupID != nil {
			conflictClause = "(channel_group_id, role_id) WHERE channel_group_id IS NOT NULL"
		} else {
			conflictClause = "(channel_id, role_id) WHERE channel_id IS NOT NULL"
		}
	}

	query := fmt.Sprintf(
		`INSERT INTO permission_overrides (id, channel_group_id, channel_id, role_id, user_id, allow, deny)
		 VALUES ($1, $2, $3, $4, $5, $6, $7)
		 ON CONFLICT %s
		   DO UPDATE SET allow = EXCLUDED.allow, deny = EXCLUDED.deny
		 RETURNING id, COALESCE(channel_group_id, ''), COALESCE(channel_id, ''), COALESCE(role_id, ''), COALESCE(user_id, ''), allow, deny`,
		conflictClause,
	)

	err := s.pool.QueryRow(ctx, query,
		override.ID, channelGroupID, channelID, roleID, userID, override.Allow, override.Deny,
	).Scan(&override.ID, &override.ChannelGroupID, &override.ChannelID, &override.RoleID, &override.UserID, &override.Allow, &override.Deny)
	if err != nil {
		return nil, fmt.Errorf("upsert permission override: %w", err)
	}
	return override, nil
}

func (s *PermissionOverrideStore) DeleteOverride(ctx context.Context, targetID, roleID string) error {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	result, err := s.pool.Exec(ctx,
		`DELETE FROM permission_overrides
		 WHERE (channel_group_id = $1 OR channel_id = $1) AND role_id = $2`,
		targetID, roleID,
	)
	if err != nil {
		return fmt.Errorf("delete permission override: %w", err)
	}
	if result.RowsAffected() == 0 {
		return fmt.Errorf("permission override not found")
	}
	return nil
}

func (s *PermissionOverrideStore) DeleteOverrideByUser(ctx context.Context, targetID, userID string) error {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	result, err := s.pool.Exec(ctx,
		`DELETE FROM permission_overrides
		 WHERE (channel_group_id = $1 OR channel_id = $1) AND user_id = $2`,
		targetID, userID,
	)
	if err != nil {
		return fmt.Errorf("delete user permission override: %w", err)
	}
	if result.RowsAffected() == 0 {
		return fmt.Errorf("user permission override not found")
	}
	return nil
}

func (s *PermissionOverrideStore) DeleteAllChannelOverrides(ctx context.Context, channelID string) error {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()
	_, err := s.pool.Exec(ctx, `DELETE FROM permission_overrides WHERE channel_id = $1`, channelID)
	return err
}

func (s *PermissionOverrideStore) CopyCategoryOverridesToChannel(ctx context.Context, channelGroupID, channelID string) error {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()
	_, err := s.pool.Exec(ctx,
		`INSERT INTO permission_overrides (id, channel_id, role_id, user_id, allow, deny)
		 SELECT gen_random_uuid(), $2, po.role_id, po.user_id, po.allow, po.deny
		 FROM permission_overrides po
		 WHERE po.channel_group_id = $1
		 ON CONFLICT DO NOTHING`,
		channelGroupID, channelID,
	)
	if err != nil {
		return fmt.Errorf("copy category overrides to channel: %w", err)
	}
	return nil
}

func (s *PermissionOverrideStore) ListOverridesByTarget(ctx context.Context, targetID string) ([]*models.PermissionOverride, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	rows, err := s.pool.Query(ctx,
		`SELECT id, COALESCE(channel_group_id, ''), COALESCE(channel_id, ''), COALESCE(role_id, ''), COALESCE(user_id, ''), allow, deny
		 FROM permission_overrides
		 WHERE channel_group_id = $1 OR channel_id = $1
		 ORDER BY role_id, user_id`, targetID,
	)
	if err != nil {
		return nil, fmt.Errorf("query permission overrides: %w", err)
	}
	defer rows.Close()

	var overrides []*models.PermissionOverride
	for rows.Next() {
		var o models.PermissionOverride
		if err := rows.Scan(&o.ID, &o.ChannelGroupID, &o.ChannelID, &o.RoleID, &o.UserID, &o.Allow, &o.Deny); err != nil {
			return nil, fmt.Errorf("scan permission override: %w", err)
		}
		overrides = append(overrides, &o)
	}
	return overrides, rows.Err()
}

// GetAllOverridesForChannel returns all overrides for a channel split into
// group-role, channel-role, group-user, and channel-user categories needed by
// the permission resolver.
func (s *PermissionOverrideStore) GetAllOverridesForChannel(ctx context.Context, channelID string, roleIDs []string, userID string) (*ChannelOverrides, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	result := &ChannelOverrides{}

	rows, err := s.pool.Query(ctx,
		`SELECT
		   CASE WHEN po.channel_group_id IS NOT NULL THEN 'group' ELSE 'channel' END AS scope,
		   CASE WHEN po.role_id IS NOT NULL THEN 'role' ELSE 'user' END AS kind,
		   po.allow, po.deny
		 FROM permission_overrides po
		 WHERE (
		     po.channel_id = $1
		     OR po.channel_group_id = (SELECT channel_group_id FROM channels WHERE id = $1)
		   )
		   AND (
		     po.role_id = ANY($2)
		     OR po.user_id = $3
		   )`,
		channelID, roleIDs, userID,
	)
	if err != nil {
		return nil, fmt.Errorf("get all overrides for channel: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		var scope, kind string
		var allow, deny int64
		if err := rows.Scan(&scope, &kind, &allow, &deny); err != nil {
			return nil, fmt.Errorf("scan override: %w", err)
		}

		ovr := permissions.Override{Allow: allow, Deny: deny}
		if kind == "role" {
			if scope == "group" {
				result.GroupRoleOverrides = append(result.GroupRoleOverrides, ovr)
			} else {
				result.ChannelRoleOverrides = append(result.ChannelRoleOverrides, ovr)
			}
		} else {
			if scope == "group" {
				result.GroupUserOverride = &ovr
			} else {
				result.ChannelUserOverride = &ovr
			}
		}
	}

	return result, rows.Err()
}

// GetAllOverridesForChannels returns all overrides for multiple channels in a single
// query, keyed by channel ID. Each channel's overrides include both direct channel-level
// and inherited channel-group-level overrides, for both roles and the specific user.
func (s *PermissionOverrideStore) GetAllOverridesForChannels(ctx context.Context, channelIDs []string, roleIDs []string, userID string) (map[string]*ChannelOverrides, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	result := make(map[string]*ChannelOverrides, len(channelIDs))
	if len(channelIDs) == 0 {
		return result, nil
	}

	rows, err := s.pool.Query(ctx,
		`SELECT
		   c.id AS channel_id,
		   CASE WHEN po.channel_group_id IS NOT NULL THEN 'group' ELSE 'channel' END AS scope,
		   CASE WHEN po.role_id IS NOT NULL THEN 'role' ELSE 'user' END AS kind,
		   po.allow, po.deny
		 FROM channels c
		 JOIN permission_overrides po
		   ON (po.channel_id = c.id OR po.channel_group_id = c.channel_group_id)
		 WHERE c.id = ANY($1)
		   AND (
		     po.role_id = ANY($2)
		     OR po.user_id = $3
		   )`,
		channelIDs, roleIDs, userID,
	)
	if err != nil {
		return nil, fmt.Errorf("get all overrides for channels batch: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		var chID, scope, kind string
		var allow, deny int64
		if err := rows.Scan(&chID, &scope, &kind, &allow, &deny); err != nil {
			return nil, fmt.Errorf("scan batch override: %w", err)
		}

		co := result[chID]
		if co == nil {
			co = &ChannelOverrides{}
			result[chID] = co
		}

		ovr := permissions.Override{Allow: allow, Deny: deny}
		if kind == "role" {
			if scope == "group" {
				co.GroupRoleOverrides = append(co.GroupRoleOverrides, ovr)
			} else {
				co.ChannelRoleOverrides = append(co.ChannelRoleOverrides, ovr)
			}
		} else {
			if scope == "group" {
				co.GroupUserOverride = &ovr
			} else {
				co.ChannelUserOverride = &ovr
			}
		}
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate batch overrides: %w", err)
	}

	return result, nil
}

