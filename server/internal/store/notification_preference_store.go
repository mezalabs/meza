package store

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/mezalabs/meza/internal/models"
)

// NotificationPreferenceStore implements NotificationPreferenceStorer using PostgreSQL.
type NotificationPreferenceStore struct {
	pool *pgxpool.Pool
}

// NewNotificationPreferenceStore creates a new NotificationPreferenceStore backed by a pgxpool.Pool.
func NewNotificationPreferenceStore(pool *pgxpool.Pool) *NotificationPreferenceStore {
	return &NotificationPreferenceStore{pool: pool}
}

func (s *NotificationPreferenceStore) GetPreferences(ctx context.Context, userID string) ([]*models.NotificationPreference, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	rows, err := s.pool.Query(ctx,
		`SELECT user_id, scope_type, scope_id, level, updated_at
		 FROM notification_preferences WHERE user_id = $1`,
		userID,
	)
	if err != nil {
		return nil, fmt.Errorf("query notification preferences: %w", err)
	}
	defer rows.Close()

	var prefs []*models.NotificationPreference
	for rows.Next() {
		var p models.NotificationPreference
		if err := rows.Scan(&p.UserID, &p.ScopeType, &p.ScopeID, &p.Level, &p.UpdatedAt); err != nil {
			return nil, fmt.Errorf("scan notification preference: %w", err)
		}
		prefs = append(prefs, &p)
	}
	return prefs, rows.Err()
}

// GetEffectiveLevel returns the most specific notification level for a user
// in a given server/channel context. Resolution order: channel > server > global.
// Returns "all" if no preference is set.
func (s *NotificationPreferenceStore) GetEffectiveLevel(ctx context.Context, userID, serverID, channelID string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	// Query all potentially matching preferences in one round-trip.
	rows, err := s.pool.Query(ctx,
		`SELECT scope_type, level FROM notification_preferences
		 WHERE user_id = $1 AND (
		   (scope_type = 'global' AND scope_id = '') OR
		   (scope_type = 'server' AND scope_id = $2) OR
		   (scope_type = 'channel' AND scope_id = $3)
		 )`,
		userID, serverID, channelID,
	)
	if err != nil {
		return "all", fmt.Errorf("query effective level: %w", err)
	}
	defer rows.Close()

	var globalLevel, serverLevel, channelLevel string
	for rows.Next() {
		var scopeType, level string
		if err := rows.Scan(&scopeType, &level); err != nil {
			return "all", fmt.Errorf("scan effective level: %w", err)
		}
		switch scopeType {
		case "channel":
			channelLevel = level
		case "server":
			serverLevel = level
		case "global":
			globalLevel = level
		}
	}
	if err := rows.Err(); err != nil {
		return "all", err
	}

	// Most specific wins.
	if channelLevel != "" {
		return channelLevel, nil
	}
	if serverLevel != "" {
		return serverLevel, nil
	}
	if globalLevel != "" {
		return globalLevel, nil
	}
	return "all", nil
}

// GetEffectiveLevelsForUsers returns the effective notification level for
// multiple users at once, using a single bulk query. Returns a map of
// userID -> level (defaults to "all" for users with no preferences).
func (s *NotificationPreferenceStore) GetEffectiveLevelsForUsers(ctx context.Context, userIDs []string, serverID, channelID string) (map[string]string, error) {
	if len(userIDs) == 0 {
		return map[string]string{}, nil
	}

	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	rows, err := s.pool.Query(ctx,
		`SELECT user_id, scope_type, level FROM notification_preferences
		 WHERE user_id = ANY($1) AND (
		   (scope_type = 'global' AND scope_id = '') OR
		   (scope_type = 'server' AND scope_id = $2) OR
		   (scope_type = 'channel' AND scope_id = $3)
		 )`,
		userIDs, serverID, channelID,
	)
	if err != nil {
		return nil, fmt.Errorf("query effective levels for users: %w", err)
	}
	defer rows.Close()

	// Collect all preferences keyed by (userID, scopeType).
	type userPrefs struct {
		global, server, channel string
	}
	byUser := make(map[string]*userPrefs, len(userIDs))
	for rows.Next() {
		var uid, scopeType, level string
		if err := rows.Scan(&uid, &scopeType, &level); err != nil {
			return nil, fmt.Errorf("scan effective level: %w", err)
		}
		up, ok := byUser[uid]
		if !ok {
			up = &userPrefs{}
			byUser[uid] = up
		}
		switch scopeType {
		case "channel":
			up.channel = level
		case "server":
			up.server = level
		case "global":
			up.global = level
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	// Resolve: channel > server > global, default "all".
	result := make(map[string]string, len(userIDs))
	for _, uid := range userIDs {
		up := byUser[uid]
		if up == nil {
			result[uid] = "all"
			continue
		}
		switch {
		case up.channel != "":
			result[uid] = up.channel
		case up.server != "":
			result[uid] = up.server
		case up.global != "":
			result[uid] = up.global
		default:
			result[uid] = "all"
		}
	}
	return result, nil
}

func (s *NotificationPreferenceStore) UpsertPreference(ctx context.Context, pref *models.NotificationPreference) error {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	_, err := s.pool.Exec(ctx,
		`INSERT INTO notification_preferences (user_id, scope_type, scope_id, level, updated_at)
		 VALUES ($1, $2, $3, $4, now())
		 ON CONFLICT (user_id, scope_type, scope_id)
		 DO UPDATE SET level = EXCLUDED.level, updated_at = now()`,
		pref.UserID, pref.ScopeType, pref.ScopeID, pref.Level,
	)
	if err != nil {
		return fmt.Errorf("upsert notification preference: %w", err)
	}
	return nil
}

func (s *NotificationPreferenceStore) DeletePreference(ctx context.Context, userID, scopeType, scopeID string) error {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	_, err := s.pool.Exec(ctx,
		`DELETE FROM notification_preferences WHERE user_id = $1 AND scope_type = $2 AND scope_id = $3`,
		userID, scopeType, scopeID,
	)
	if err != nil {
		return fmt.Errorf("delete notification preference: %w", err)
	}
	return nil
}

// Ensure NotificationPreferenceStore does not accidentally skip the pgx.ErrNoRows import.
var _ = pgx.ErrNoRows
