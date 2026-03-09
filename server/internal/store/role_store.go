package store

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/mezalabs/meza/internal/models"
)

// RoleStore implements RoleStorer using PostgreSQL.
type RoleStore struct {
	pool *pgxpool.Pool
}

// NewRoleStore creates a new RoleStore backed by a pgxpool.Pool.
func NewRoleStore(pool *pgxpool.Pool) *RoleStore {
	return &RoleStore{pool: pool}
}

func (s *RoleStore) CreateRole(ctx context.Context, role *models.Role) (*models.Role, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx)

	// Lock all roles for this server to prevent concurrent MAX(position) races.
	_, err = tx.Exec(ctx, `SELECT id FROM roles WHERE server_id = $1 FOR UPDATE`, role.ServerID)
	if err != nil {
		return nil, fmt.Errorf("lock server roles: %w", err)
	}

	// Auto-assign position as MAX(position)+1 for the server (just above the highest existing role).
	// @everyone is always 0, so new roles start at 1 if no other roles exist.
	err = tx.QueryRow(ctx,
		`INSERT INTO roles (id, server_id, name, permissions, color, position, is_self_assignable, created_at)
		 VALUES ($1, $2, $3, $4, $5,
		   COALESCE((SELECT MAX(position) FROM roles WHERE server_id = $2), 0) + 1,
		   $6, $7)
		 RETURNING id, server_id, name, permissions, color, position, is_self_assignable, created_at`,
		role.ID, role.ServerID, role.Name, role.Permissions, role.Color, role.IsSelfAssignable, role.CreatedAt,
	).Scan(&role.ID, &role.ServerID, &role.Name, &role.Permissions, &role.Color, &role.Position, &role.IsSelfAssignable, &role.CreatedAt)
	if err != nil {
		return nil, fmt.Errorf("insert role: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit create role: %w", err)
	}
	return role, nil
}

func (s *RoleStore) GetRole(ctx context.Context, roleID string) (*models.Role, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	var r models.Role
	err := s.pool.QueryRow(ctx,
		`SELECT id, server_id, name, permissions, color, position, is_self_assignable, created_at
		 FROM roles WHERE id = $1`, roleID,
	).Scan(&r.ID, &r.ServerID, &r.Name, &r.Permissions, &r.Color, &r.Position, &r.IsSelfAssignable, &r.CreatedAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, fmt.Errorf("role not found")
		}
		return nil, fmt.Errorf("query role: %w", err)
	}
	return &r, nil
}

func (s *RoleStore) ListRoles(ctx context.Context, serverID string) ([]*models.Role, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	rows, err := s.pool.Query(ctx,
		`SELECT id, server_id, name, permissions, color, position, is_self_assignable, created_at
		 FROM roles WHERE server_id = $1
		 ORDER BY position DESC`, serverID,
	)
	if err != nil {
		return nil, fmt.Errorf("query roles: %w", err)
	}
	defer rows.Close()

	var roles []*models.Role
	for rows.Next() {
		var r models.Role
		if err := rows.Scan(&r.ID, &r.ServerID, &r.Name, &r.Permissions, &r.Color, &r.Position, &r.IsSelfAssignable, &r.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan role: %w", err)
		}
		roles = append(roles, &r)
	}
	return roles, rows.Err()
}

func (s *RoleStore) UpdateRole(ctx context.Context, roleID string, name *string, permissions *int64, color *int, isSelfAssignable *bool) (*models.Role, error) {
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
	if permissions != nil {
		setClauses = append(setClauses, fmt.Sprintf("permissions = $%d", argIdx))
		args = append(args, *permissions)
		argIdx++
	}
	if color != nil {
		setClauses = append(setClauses, fmt.Sprintf("color = $%d", argIdx))
		args = append(args, *color)
		argIdx++
	}
	if isSelfAssignable != nil {
		setClauses = append(setClauses, fmt.Sprintf("is_self_assignable = $%d", argIdx))
		args = append(args, *isSelfAssignable)
		argIdx++
	}

	if len(setClauses) == 0 {
		return s.GetRole(ctx, roleID)
	}

	query := fmt.Sprintf(
		"UPDATE roles SET %s WHERE id = $%d RETURNING id, server_id, name, permissions, color, position, is_self_assignable, created_at",
		strings.Join(setClauses, ", "),
		argIdx,
	)
	args = append(args, roleID)

	var r models.Role
	err := s.pool.QueryRow(ctx, query, args...).Scan(
		&r.ID, &r.ServerID, &r.Name, &r.Permissions, &r.Color, &r.Position, &r.IsSelfAssignable, &r.CreatedAt,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, fmt.Errorf("role not found")
		}
		return nil, fmt.Errorf("update role: %w", err)
	}
	return &r, nil
}

func (s *RoleStore) DeleteRole(ctx context.Context, roleID string) error {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx)

	// Lock ALL roles for this server to prevent concurrent position mutations.
	// First, get the server_id and position of the target role.
	var serverID string
	var position int
	err = tx.QueryRow(ctx,
		`SELECT server_id, position FROM roles WHERE id = $1`, roleID,
	).Scan(&serverID, &position)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return fmt.Errorf("role not found")
		}
		return fmt.Errorf("find role: %w", err)
	}

	// Lock all roles for this server to serialize position mutations.
	_, err = tx.Exec(ctx, `SELECT id FROM roles WHERE server_id = $1 FOR UPDATE`, serverID)
	if err != nil {
		return fmt.Errorf("lock server roles: %w", err)
	}

	// Delete the role.
	_, err = tx.Exec(ctx, `DELETE FROM roles WHERE id = $1`, roleID)
	if err != nil {
		return fmt.Errorf("delete role: %w", err)
	}

	// Compact positions: shift all roles above the deleted position down by 1.
	_, err = tx.Exec(ctx,
		`UPDATE roles SET position = position - 1 WHERE server_id = $1 AND position > $2`,
		serverID, position,
	)
	if err != nil {
		return fmt.Errorf("compact positions: %w", err)
	}

	return tx.Commit(ctx)
}

func (s *RoleStore) ReorderRoles(ctx context.Context, serverID string, roleIDs []string, callerPosition int) ([]*models.Role, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx)

	// 1. Lock ALL non-@everyone roles for this server to prevent concurrent mutations.
	rows, err := tx.Query(ctx,
		`SELECT id, position FROM roles
		 WHERE server_id = $1 AND id != $1
		 ORDER BY position
		 FOR UPDATE`,
		serverID,
	)
	if err != nil {
		return nil, fmt.Errorf("lock roles: %w", err)
	}

	existingRoles := make(map[string]int) // id -> position
	for rows.Next() {
		var id string
		var pos int
		if err := rows.Scan(&id, &pos); err != nil {
			rows.Close()
			return nil, fmt.Errorf("scan locked role: %w", err)
		}
		existingRoles[id] = pos
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate locked roles: %w", err)
	}

	// 2. Verify completeness: roleIDs must contain exactly the roles below caller's position.
	belowCaller := make(map[string]struct{})
	for id, pos := range existingRoles {
		if pos < callerPosition {
			belowCaller[id] = struct{}{}
		}
	}

	if len(roleIDs) != len(belowCaller) {
		return nil, fmt.Errorf("role_ids must contain all %d roles below your position", len(belowCaller))
	}
	for _, id := range roleIDs {
		if _, ok := belowCaller[id]; !ok {
			return nil, fmt.Errorf("role %s is not below your position or does not exist", id)
		}
	}

	// 3. Assign contiguous positions: roleIDs[0] = 1, roleIDs[1] = 2, ...
	//    Roles at or above caller's position keep their positions unchanged.
	positions := make([]int, len(roleIDs))
	for i := range roleIDs {
		positions[i] = i + 1 // 1-based, @everyone keeps 0
	}

	_, err = tx.Exec(ctx,
		`UPDATE roles SET position = data.new_pos
		 FROM (SELECT UNNEST($1::text[]) AS id, UNNEST($2::int[]) AS new_pos) AS data
		 WHERE roles.id = data.id`,
		roleIDs, positions,
	)
	if err != nil {
		return nil, fmt.Errorf("batch update positions: %w", err)
	}

	// 4. Shift roles at/above caller's position to maintain contiguity.
	//    They keep their relative order but start after the reordered roles.
	aboveCallerOffset := len(roleIDs) + 1
	_, err = tx.Exec(ctx,
		`UPDATE roles SET position = $3 + sub.rn - 1
		 FROM (
		   SELECT id, ROW_NUMBER() OVER (ORDER BY position) AS rn
		   FROM roles
		   WHERE server_id = $1 AND id != $1 AND position >= $2
		 ) sub
		 WHERE roles.id = sub.id`,
		serverID, callerPosition, aboveCallerOffset,
	)
	// Note: this query won't match any rows for owners (callerPosition = math.MaxInt32),
	// which is correct — owners reorder all roles and there are none "above" them.
	if err != nil {
		return nil, fmt.Errorf("shift above-caller positions: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit reorder: %w", err)
	}

	// Return the full updated role list.
	return s.ListRoles(ctx, serverID)
}

func (s *RoleStore) GetRolesByIDs(ctx context.Context, roleIDs []string, serverID string) ([]*models.Role, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	rows, err := s.pool.Query(ctx,
		`SELECT id, server_id, name, permissions, color, position, is_self_assignable, created_at
		 FROM roles WHERE id = ANY($1) AND server_id = $2`,
		roleIDs, serverID,
	)
	if err != nil {
		return nil, fmt.Errorf("query roles by ids: %w", err)
	}
	defer rows.Close()

	var roles []*models.Role
	for rows.Next() {
		r := &models.Role{}
		if err := rows.Scan(&r.ID, &r.ServerID, &r.Name, &r.Permissions, &r.Color, &r.Position, &r.IsSelfAssignable, &r.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan role: %w", err)
		}
		roles = append(roles, r)
	}
	return roles, rows.Err()
}

func (s *RoleStore) SetMemberRoles(ctx context.Context, userID, serverID string, roleIDs []string) error {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx)

	// Lock target member row to prevent concurrent RemoveMember during mutation.
	var exists bool
	err = tx.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM members WHERE user_id = $1 AND server_id = $2 FOR UPDATE)`,
		userID, serverID,
	).Scan(&exists)
	if err != nil {
		return fmt.Errorf("check member: %w", err)
	}
	if !exists {
		return fmt.Errorf("member not found")
	}

	// Delete existing role assignments.
	_, err = tx.Exec(ctx,
		`DELETE FROM member_roles WHERE user_id = $1 AND server_id = $2`,
		userID, serverID,
	)
	if err != nil {
		return fmt.Errorf("delete member roles: %w", err)
	}

	// Batch insert using UNNEST (single statement regardless of role count).
	if len(roleIDs) > 0 {
		_, err = tx.Exec(ctx,
			`INSERT INTO member_roles (user_id, server_id, role_id)
			 SELECT $1, $2, unnest($3::text[])`,
			userID, serverID, roleIDs,
		)
		if err != nil {
			return fmt.Errorf("insert member roles: %w", err)
		}
	}

	return tx.Commit(ctx)
}

func (s *RoleStore) GetMemberRoles(ctx context.Context, userID, serverID string) ([]*models.Role, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	rows, err := s.pool.Query(ctx,
		`SELECT r.id, r.server_id, r.name, r.permissions, r.color, r.position, r.is_self_assignable, r.created_at
		 FROM member_roles mr
		 JOIN roles r ON r.id = mr.role_id
		 WHERE mr.user_id = $1 AND mr.server_id = $2
		 ORDER BY r.position DESC`,
		userID, serverID,
	)
	if err != nil {
		return nil, fmt.Errorf("query member roles: %w", err)
	}
	defer rows.Close()

	var roles []*models.Role
	for rows.Next() {
		var r models.Role
		if err := rows.Scan(&r.ID, &r.ServerID, &r.Name, &r.Permissions, &r.Color, &r.Position, &r.IsSelfAssignable, &r.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan role: %w", err)
		}
		roles = append(roles, &r)
	}
	return roles, rows.Err()
}
