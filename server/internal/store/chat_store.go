package store

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/mezalabs/meza/internal/models"
	"github.com/mezalabs/meza/internal/permissions"
)

// ChatStore implements ChatStorer using PostgreSQL.
type ChatStore struct {
	pool *pgxpool.Pool
}

// NewChatStore creates a new ChatStore backed by a pgxpool.Pool.
func NewChatStore(pool *pgxpool.Pool) *ChatStore {
	return &ChatStore{pool: pool}
}

func (s *ChatStore) CreateServer(ctx context.Context, name, ownerID string, iconURL *string, defaultChannelPrivacy bool) (*models.Server, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx)

	now := time.Now()
	serverID := models.NewID()
	channelID := models.NewID()

	_, err = tx.Exec(ctx,
		`INSERT INTO servers (id, name, icon_url, owner_id, created_at, default_channel_privacy) VALUES ($1, $2, $3, $4, $5, $6)`,
		serverID, name, iconURL, ownerID, now, defaultChannelPrivacy,
	)
	if err != nil {
		return nil, fmt.Errorf("insert server: %w", err)
	}

	_, err = tx.Exec(ctx,
		`INSERT INTO members (user_id, server_id, joined_at) VALUES ($1, $2, $3)`,
		ownerID, serverID, now,
	)
	if err != nil {
		return nil, fmt.Errorf("insert member: %w", err)
	}

	// Create @everyone role (id = serverID, position 0, default permissions).
	_, err = tx.Exec(ctx,
		`INSERT INTO roles (id, server_id, name, permissions, color, position, created_at)
		 VALUES ($1, $1, '@everyone', $2, 0, 0, $3)`,
		serverID, permissions.DefaultEveryonePermissions, now,
	)
	if err != nil {
		return nil, fmt.Errorf("insert everyone role: %w", err)
	}

	_, err = tx.Exec(ctx,
		`INSERT INTO channels (id, server_id, name, type, position, is_private, channel_group_id, created_at) VALUES ($1, $2, $3, $4, $5, $6, NULL, $7)`,
		channelID, serverID, "general", 1, 0, false, now,
	)
	if err != nil {
		return nil, fmt.Errorf("insert default channel: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit tx: %w", err)
	}

	return &models.Server{
		ID:                    serverID,
		Name:                  name,
		IconURL:               iconURL,
		OwnerID:               ownerID,
		CreatedAt:             now,
		DefaultChannelPrivacy: defaultChannelPrivacy,
	}, nil
}

func (s *ChatStore) GetServer(ctx context.Context, serverID string) (*models.Server, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	var srv models.Server
	err := s.pool.QueryRow(ctx,
		`SELECT id, name, icon_url, owner_id, created_at, welcome_message, rules, onboarding_enabled, rules_required, default_channel_privacy, banner_url
		 FROM servers WHERE id = $1`, serverID,
	).Scan(&srv.ID, &srv.Name, &srv.IconURL, &srv.OwnerID, &srv.CreatedAt,
		&srv.WelcomeMessage, &srv.Rules, &srv.OnboardingEnabled, &srv.RulesRequired, &srv.DefaultChannelPrivacy, &srv.BannerURL)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, fmt.Errorf("server not found")
		}
		return nil, fmt.Errorf("query server: %w", err)
	}
	return &srv, nil
}

func (s *ChatStore) ListServers(ctx context.Context, userID string) ([]*models.Server, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	rows, err := s.pool.Query(ctx,
		`SELECT s.id, s.name, s.icon_url, s.owner_id, s.created_at,
		        s.welcome_message, s.rules, s.onboarding_enabled, s.rules_required, s.default_channel_privacy, s.banner_url
		 FROM servers s JOIN members m ON m.server_id = s.id
		 WHERE m.user_id = $1
		 ORDER BY s.created_at`, userID,
	)
	if err != nil {
		return nil, fmt.Errorf("query servers: %w", err)
	}
	defer rows.Close()

	var servers []*models.Server
	for rows.Next() {
		var srv models.Server
		if err := rows.Scan(&srv.ID, &srv.Name, &srv.IconURL, &srv.OwnerID, &srv.CreatedAt,
			&srv.WelcomeMessage, &srv.Rules, &srv.OnboardingEnabled, &srv.RulesRequired, &srv.DefaultChannelPrivacy, &srv.BannerURL); err != nil {
			return nil, fmt.Errorf("scan server: %w", err)
		}
		servers = append(servers, &srv)
	}
	return servers, nil
}

func (s *ChatStore) ListAllServers(ctx context.Context) ([]*models.Server, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	rows, err := s.pool.Query(ctx,
		`SELECT s.id, s.name, s.icon_url, s.owner_id, s.created_at,
		        s.welcome_message, s.rules, s.onboarding_enabled, s.rules_required, s.default_channel_privacy, s.banner_url
		 FROM servers s
		 ORDER BY s.created_at`)
	if err != nil {
		return nil, fmt.Errorf("query all servers: %w", err)
	}
	defer rows.Close()

	var servers []*models.Server
	for rows.Next() {
		var srv models.Server
		if err := rows.Scan(&srv.ID, &srv.Name, &srv.IconURL, &srv.OwnerID, &srv.CreatedAt,
			&srv.WelcomeMessage, &srv.Rules, &srv.OnboardingEnabled, &srv.RulesRequired, &srv.DefaultChannelPrivacy, &srv.BannerURL); err != nil {
			return nil, fmt.Errorf("scan server: %w", err)
		}
		servers = append(servers, &srv)
	}
	return servers, nil
}

func (s *ChatStore) CreateChannel(ctx context.Context, serverID, name string, channelType int, isPrivate bool, channelGroupID string) (*models.Channel, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	channelID := models.NewID()
	now := time.Now()

	var groupID *string
	if channelGroupID != "" {
		groupID = &channelGroupID
	}

	permSynced := groupID != nil

	var ch models.Channel
	err := s.pool.QueryRow(ctx,
		`INSERT INTO channels (id, server_id, name, type, position, is_private, channel_group_id, permissions_synced, created_at)
		 SELECT $1, $2, $3, $4, COALESCE(MAX(position), -1) + 1, $5, $6, $7, $8
		 FROM channels WHERE server_id = $9
		 RETURNING id, server_id, name, type, position, is_private, COALESCE(channel_group_id, ''), dm_status, COALESCE(dm_initiator_id, ''), content_warning, COALESCE(voice_text_channel_id, ''), permissions_synced, created_at`,
		channelID, serverID, name, channelType, isPrivate, groupID, permSynced, now, serverID,
	).Scan(&ch.ID, &ch.ServerID, &ch.Name, &ch.Type, &ch.Position, &ch.IsPrivate, &ch.ChannelGroupID, &ch.DMStatus, &ch.DMInitiatorID, &ch.ContentWarning, &ch.VoiceTextChannelID, &ch.PermissionsSynced, &ch.CreatedAt)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return nil, fmt.Errorf("channel %w", ErrAlreadyExists)
		}
		return nil, fmt.Errorf("insert channel: %w", err)
	}

	return &ch, nil
}

func (s *ChatStore) GetChannel(ctx context.Context, channelID string) (*models.Channel, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	var ch models.Channel
	err := s.pool.QueryRow(ctx,
		`SELECT id, COALESCE(server_id, ''), name, type, topic, position, is_private, slow_mode_seconds, is_default, COALESCE(channel_group_id, ''), dm_status, COALESCE(dm_initiator_id, ''), content_warning, COALESCE(voice_text_channel_id, ''), permissions_synced, created_at FROM channels WHERE id = $1`, channelID,
	).Scan(&ch.ID, &ch.ServerID, &ch.Name, &ch.Type, &ch.Topic, &ch.Position, &ch.IsPrivate, &ch.SlowModeSeconds, &ch.IsDefault, &ch.ChannelGroupID, &ch.DMStatus, &ch.DMInitiatorID, &ch.ContentWarning, &ch.VoiceTextChannelID, &ch.PermissionsSynced, &ch.CreatedAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, fmt.Errorf("channel %w", ErrNotFound)
		}
		return nil, fmt.Errorf("query channel: %w", err)
	}
	return &ch, nil
}

func (s *ChatStore) ListChannels(ctx context.Context, serverID, userID string) ([]*models.Channel, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	// Return all server channels — the service layer filters by ViewChannel permission.
	rows, err := s.pool.Query(ctx,
		`SELECT c.id, COALESCE(c.server_id, ''), c.name, c.type, c.topic, c.position, c.is_private, c.slow_mode_seconds, c.is_default, COALESCE(c.channel_group_id, ''), c.dm_status, COALESCE(c.dm_initiator_id, ''), c.content_warning, COALESCE(c.voice_text_channel_id, ''), c.permissions_synced, c.created_at
		 FROM channels c
		 WHERE c.server_id = $1
		 ORDER BY c.position`, serverID,
	)
	if err != nil {
		return nil, fmt.Errorf("query channels: %w", err)
	}
	defer rows.Close()

	var channels []*models.Channel
	for rows.Next() {
		var ch models.Channel
		if err := rows.Scan(&ch.ID, &ch.ServerID, &ch.Name, &ch.Type, &ch.Topic, &ch.Position, &ch.IsPrivate, &ch.SlowModeSeconds, &ch.IsDefault, &ch.ChannelGroupID, &ch.DMStatus, &ch.DMInitiatorID, &ch.ContentWarning, &ch.VoiceTextChannelID, &ch.PermissionsSynced, &ch.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan channel: %w", err)
		}
		channels = append(channels, &ch)
	}
	return channels, nil
}

func (s *ChatStore) UpdateChannel(ctx context.Context, channelID string, name, topic *string, position *int, isPrivate *bool, slowModeSeconds *int, isDefault *bool, channelGroupID, contentWarning *string) (*models.Channel, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	// Build dynamic SET clause from non-nil fields.
	setClauses := []string{}
	args := []any{}
	argIdx := 1

	if name != nil {
		setClauses = append(setClauses, fmt.Sprintf("name = $%d", argIdx))
		args = append(args, *name)
		argIdx++
	}
	if topic != nil {
		setClauses = append(setClauses, fmt.Sprintf("topic = $%d", argIdx))
		args = append(args, *topic)
		argIdx++
	}
	if position != nil {
		setClauses = append(setClauses, fmt.Sprintf("position = $%d", argIdx))
		args = append(args, *position)
		argIdx++
	}
	if isPrivate != nil {
		setClauses = append(setClauses, fmt.Sprintf("is_private = $%d", argIdx))
		args = append(args, *isPrivate)
		argIdx++
	}
	if slowModeSeconds != nil {
		setClauses = append(setClauses, fmt.Sprintf("slow_mode_seconds = $%d", argIdx))
		args = append(args, *slowModeSeconds)
		argIdx++
	}
	if isDefault != nil {
		setClauses = append(setClauses, fmt.Sprintf("is_default = $%d", argIdx))
		args = append(args, *isDefault)
		argIdx++
	}
	if channelGroupID != nil {
		if *channelGroupID == "" {
			setClauses = append(setClauses, fmt.Sprintf("channel_group_id = NULL"))
		} else {
			setClauses = append(setClauses, fmt.Sprintf("channel_group_id = $%d", argIdx))
			args = append(args, *channelGroupID)
			argIdx++
		}
	}
	if contentWarning != nil {
		setClauses = append(setClauses, fmt.Sprintf("content_warning = $%d", argIdx))
		args = append(args, *contentWarning)
		argIdx++
	}

	if len(setClauses) == 0 {
		// Nothing to update, just return the current channel.
		return s.GetChannel(ctx, channelID)
	}

	query := fmt.Sprintf(
		"UPDATE channels SET %s WHERE id = $%d RETURNING id, COALESCE(server_id, ''), name, type, topic, position, is_private, slow_mode_seconds, is_default, COALESCE(channel_group_id, ''), dm_status, COALESCE(dm_initiator_id, ''), content_warning, COALESCE(voice_text_channel_id, ''), permissions_synced, created_at",
		strings.Join(setClauses, ", "),
		argIdx,
	)
	args = append(args, channelID)

	var ch models.Channel
	err := s.pool.QueryRow(ctx, query, args...).Scan(
		&ch.ID, &ch.ServerID, &ch.Name, &ch.Type, &ch.Topic, &ch.Position, &ch.IsPrivate, &ch.SlowModeSeconds, &ch.IsDefault, &ch.ChannelGroupID, &ch.DMStatus, &ch.DMInitiatorID, &ch.ContentWarning, &ch.VoiceTextChannelID, &ch.PermissionsSynced, &ch.CreatedAt,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, fmt.Errorf("channel not found")
		}
		return nil, fmt.Errorf("update channel: %w", err)
	}
	return &ch, nil
}

// UpdateChannelPrivacy atomically updates the channel and manages the ViewChannel
// permission override on @everyone within a single transaction.
func (s *ChatStore) UpdateChannelPrivacy(ctx context.Context, channelID string, name, topic *string, position *int, isPrivate *bool, slowModeSeconds *int, isDefault *bool, channelGroupID, contentWarning *string, oldIsPrivate bool, everyoneRoleID string, viewChannelPerm int64) (*models.Channel, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx)

	// Build dynamic SET clause from non-nil fields.
	setClauses := []string{}
	args := []any{}
	argIdx := 1

	if name != nil {
		setClauses = append(setClauses, fmt.Sprintf("name = $%d", argIdx))
		args = append(args, *name)
		argIdx++
	}
	if topic != nil {
		setClauses = append(setClauses, fmt.Sprintf("topic = $%d", argIdx))
		args = append(args, *topic)
		argIdx++
	}
	if position != nil {
		setClauses = append(setClauses, fmt.Sprintf("position = $%d", argIdx))
		args = append(args, *position)
		argIdx++
	}
	if isPrivate != nil {
		setClauses = append(setClauses, fmt.Sprintf("is_private = $%d", argIdx))
		args = append(args, *isPrivate)
		argIdx++
	}
	if slowModeSeconds != nil {
		setClauses = append(setClauses, fmt.Sprintf("slow_mode_seconds = $%d", argIdx))
		args = append(args, *slowModeSeconds)
		argIdx++
	}
	if isDefault != nil {
		setClauses = append(setClauses, fmt.Sprintf("is_default = $%d", argIdx))
		args = append(args, *isDefault)
		argIdx++
	}
	if channelGroupID != nil {
		if *channelGroupID == "" {
			setClauses = append(setClauses, "channel_group_id = NULL")
		} else {
			setClauses = append(setClauses, fmt.Sprintf("channel_group_id = $%d", argIdx))
			args = append(args, *channelGroupID)
			argIdx++
		}
	}
	if contentWarning != nil {
		setClauses = append(setClauses, fmt.Sprintf("content_warning = $%d", argIdx))
		args = append(args, *contentWarning)
		argIdx++
	}

	if len(setClauses) == 0 {
		return s.GetChannel(ctx, channelID)
	}

	query := fmt.Sprintf(
		"UPDATE channels SET %s WHERE id = $%d RETURNING id, COALESCE(server_id, ''), name, type, topic, position, is_private, slow_mode_seconds, is_default, COALESCE(channel_group_id, ''), dm_status, COALESCE(dm_initiator_id, ''), content_warning, COALESCE(voice_text_channel_id, ''), permissions_synced, created_at",
		strings.Join(setClauses, ", "),
		argIdx,
	)
	args = append(args, channelID)

	var ch models.Channel
	err = tx.QueryRow(ctx, query, args...).Scan(
		&ch.ID, &ch.ServerID, &ch.Name, &ch.Type, &ch.Topic, &ch.Position, &ch.IsPrivate, &ch.SlowModeSeconds, &ch.IsDefault, &ch.ChannelGroupID, &ch.DMStatus, &ch.DMInitiatorID, &ch.ContentWarning, &ch.VoiceTextChannelID, &ch.PermissionsSynced, &ch.CreatedAt,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, fmt.Errorf("channel not found")
		}
		return nil, fmt.Errorf("update channel: %w", err)
	}

	// Manage ViewChannel override on @everyone when privacy actually changed.
	if isPrivate != nil && *isPrivate != oldIsPrivate {
		if *isPrivate {
			// Public -> private: upsert ViewChannel deny on @everyone.
			overrideID := models.NewID()
			_, err = tx.Exec(ctx,
				`INSERT INTO permission_overrides (id, channel_id, role_id, allow, deny)
				 VALUES ($1, $2, $3, 0, $4)
				 ON CONFLICT (channel_id, role_id) WHERE channel_id IS NOT NULL
				   DO UPDATE SET deny = EXCLUDED.deny`,
				overrideID, channelID, everyoneRoleID, viewChannelPerm,
			)
			if err != nil {
				return nil, fmt.Errorf("set ViewChannel deny override: %w", err)
			}
		} else {
			// Private -> public: remove ViewChannel deny on @everyone.
			_, err = tx.Exec(ctx,
				`DELETE FROM permission_overrides
				 WHERE (channel_group_id = $1 OR channel_id = $1) AND role_id = $2`,
				channelID, everyoneRoleID,
			)
			if err != nil {
				return nil, fmt.Errorf("remove ViewChannel deny override: %w", err)
			}
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit tx: %w", err)
	}
	return &ch, nil
}

func (s *ChatStore) DeleteChannel(ctx context.Context, channelID string) error {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	result, err := s.pool.Exec(ctx, `DELETE FROM channels WHERE id = $1`, channelID)
	if err != nil {
		return fmt.Errorf("delete channel: %w", err)
	}
	if result.RowsAffected() == 0 {
		return fmt.Errorf("channel not found")
	}
	return nil
}

func (s *ChatStore) CreateVoiceChannelWithCompanion(ctx context.Context, serverID, name string, isPrivate bool, channelGroupID string) (*models.Channel, *models.Channel, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, nil, fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx)

	voiceID := models.NewID()
	textID := models.NewID()
	now := time.Now()

	var groupID *string
	if channelGroupID != "" {
		groupID = &channelGroupID
	}
	permSynced := groupID != nil

	// Create the companion text channel FIRST so the FK reference from the voice
	// channel is valid (PostgreSQL checks FK constraints at statement time).
	var textCh models.Channel
	err = tx.QueryRow(ctx,
		`INSERT INTO channels (id, server_id, name, type, position, is_private, channel_group_id, permissions_synced, created_at)
		 SELECT $1, $2, $3, 1, COALESCE(MAX(position), -1) + 1, $4, $5, $6, $7
		 FROM channels WHERE server_id = $8
		 RETURNING id, server_id, name, type, position, is_private, COALESCE(channel_group_id, ''), dm_status, COALESCE(dm_initiator_id, ''), COALESCE(voice_text_channel_id, ''), permissions_synced, created_at`,
		textID, serverID, name, isPrivate, groupID, permSynced, now, serverID,
	).Scan(&textCh.ID, &textCh.ServerID, &textCh.Name, &textCh.Type, &textCh.Position, &textCh.IsPrivate, &textCh.ChannelGroupID, &textCh.DMStatus, &textCh.DMInitiatorID, &textCh.VoiceTextChannelID, &textCh.PermissionsSynced, &textCh.CreatedAt)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return nil, nil, fmt.Errorf("channel %w", ErrAlreadyExists)
		}
		return nil, nil, fmt.Errorf("insert companion text channel: %w", err)
	}

	// Create the voice channel with FK reference to the companion.
	var voiceCh models.Channel
	err = tx.QueryRow(ctx,
		`INSERT INTO channels (id, server_id, name, type, position, is_private, channel_group_id, voice_text_channel_id, permissions_synced, created_at)
		 VALUES ($1, $2, $3, 2, $4, $5, $6, $7, $8, $9)
		 RETURNING id, server_id, name, type, position, is_private, COALESCE(channel_group_id, ''), dm_status, COALESCE(dm_initiator_id, ''), COALESCE(voice_text_channel_id, ''), permissions_synced, created_at`,
		voiceID, serverID, name, textCh.Position, isPrivate, groupID, textID, permSynced, now,
	).Scan(&voiceCh.ID, &voiceCh.ServerID, &voiceCh.Name, &voiceCh.Type, &voiceCh.Position, &voiceCh.IsPrivate, &voiceCh.ChannelGroupID, &voiceCh.DMStatus, &voiceCh.DMInitiatorID, &voiceCh.VoiceTextChannelID, &voiceCh.PermissionsSynced, &voiceCh.CreatedAt)
	if err != nil {
		return nil, nil, fmt.Errorf("insert voice channel: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, nil, fmt.Errorf("commit tx: %w", err)
	}
	return &voiceCh, &textCh, nil
}

func (s *ChatStore) DeleteChannelWithCompanion(ctx context.Context, voiceChannelID, companionChannelID string) error {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx)

	// Delete companion first (FK on voice channel points to it).
	_, err = tx.Exec(ctx, `DELETE FROM channels WHERE id = $1`, companionChannelID)
	if err != nil {
		return fmt.Errorf("delete companion channel: %w", err)
	}

	result, err := tx.Exec(ctx, `DELETE FROM channels WHERE id = $1`, voiceChannelID)
	if err != nil {
		return fmt.Errorf("delete voice channel: %w", err)
	}
	if result.RowsAffected() == 0 {
		return fmt.Errorf("voice channel not found")
	}

	return tx.Commit(ctx)
}

func (s *ChatStore) IsVoiceTextCompanion(ctx context.Context, channelID string) (bool, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	var exists bool
	err := s.pool.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM channels WHERE voice_text_channel_id = $1)`, channelID,
	).Scan(&exists)
	if err != nil {
		return false, fmt.Errorf("check voice text companion: %w", err)
	}
	return exists, nil
}

func (s *ChatStore) UpdateCompanionChannel(ctx context.Context, companionID string, name, topic *string, channelGroupID *string) error {
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
	if topic != nil {
		setClauses = append(setClauses, fmt.Sprintf("topic = $%d", argIdx))
		args = append(args, *topic)
		argIdx++
	}
	if channelGroupID != nil {
		setClauses = append(setClauses, fmt.Sprintf("channel_group_id = $%d", argIdx))
		if *channelGroupID == "" {
			args = append(args, nil)
		} else {
			args = append(args, *channelGroupID)
		}
		argIdx++
	}

	if len(setClauses) == 0 {
		return nil
	}

	query := fmt.Sprintf("UPDATE channels SET %s WHERE id = $%d", strings.Join(setClauses, ", "), argIdx)
	args = append(args, companionID)

	_, err := s.pool.Exec(ctx, query, args...)
	if err != nil {
		return fmt.Errorf("update companion channel: %w", err)
	}
	return nil
}

func (s *ChatStore) SetPermissionsSynced(ctx context.Context, channelID string, synced bool) error {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()
	_, err := s.pool.Exec(ctx, `UPDATE channels SET permissions_synced = $1, updated_at = now() WHERE id = $2`, synced, channelID)
	return err
}

// SyncChannelToCategory atomically deletes all channel-level overrides and
// marks the channel as synced. If companionID is non-empty, the companion
// channel is also synced in the same transaction.
func (s *ChatStore) SyncChannelToCategory(ctx context.Context, channelID, companionID string) error {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx)

	// Delete all channel-level overrides.
	if _, err := tx.Exec(ctx, `DELETE FROM permission_overrides WHERE channel_id = $1`, channelID); err != nil {
		return fmt.Errorf("delete channel overrides: %w", err)
	}
	// Mark as synced.
	if _, err := tx.Exec(ctx, `UPDATE channels SET permissions_synced = true, updated_at = now() WHERE id = $1`, channelID); err != nil {
		return fmt.Errorf("set permissions synced: %w", err)
	}

	// Mirror to companion if applicable.
	if companionID != "" {
		if _, err := tx.Exec(ctx, `DELETE FROM permission_overrides WHERE channel_id = $1`, companionID); err != nil {
			return fmt.Errorf("delete companion overrides: %w", err)
		}
		if _, err := tx.Exec(ctx, `UPDATE channels SET permissions_synced = true, updated_at = now() WHERE id = $1`, companionID); err != nil {
			return fmt.Errorf("set companion synced: %w", err)
		}
	}

	return tx.Commit(ctx)
}

// DeleteChannelGroupWithSnapshot atomically copies category overrides to all
// channels in the group, marks them as unsynced, and deletes the group.
func (s *ChatStore) DeleteChannelGroupWithSnapshot(ctx context.Context, channelGroupID string) error {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx)

	// Copy category overrides to all channels in the group.
	_, err = tx.Exec(ctx,
		`INSERT INTO permission_overrides (id, channel_id, role_id, user_id, allow, deny)
		 SELECT gen_random_uuid(), c.id, po.role_id, po.user_id, po.allow, po.deny
		 FROM permission_overrides po
		 JOIN channels c ON c.channel_group_id = $1
		 WHERE po.channel_group_id = $1
		 ON CONFLICT DO NOTHING`,
		channelGroupID,
	)
	if err != nil {
		return fmt.Errorf("copy category overrides: %w", err)
	}

	// Mark all channels in the group as unsynced.
	_, err = tx.Exec(ctx,
		`UPDATE channels SET permissions_synced = false WHERE channel_group_id = $1`,
		channelGroupID,
	)
	if err != nil {
		return fmt.Errorf("unsync channels: %w", err)
	}

	// Delete the channel group.
	result, err := tx.Exec(ctx, `DELETE FROM channel_groups WHERE id = $1`, channelGroupID)
	if err != nil {
		return fmt.Errorf("delete channel group: %w", err)
	}
	if result.RowsAffected() == 0 {
		return fmt.Errorf("channel group %w", ErrNotFound)
	}

	return tx.Commit(ctx)
}

func (s *ChatStore) AddMember(ctx context.Context, userID, serverID string) error {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	_, err := s.pool.Exec(ctx,
		`INSERT INTO members (user_id, server_id, joined_at) VALUES ($1, $2, $3)
		 ON CONFLICT (user_id, server_id) DO NOTHING`,
		userID, serverID, time.Now(),
	)
	if err != nil {
		return fmt.Errorf("insert member: %w", err)
	}
	return nil
}

func (s *ChatStore) RemoveMember(ctx context.Context, userID, serverID string) error {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	_, err := s.pool.Exec(ctx,
		`DELETE FROM members WHERE user_id = $1 AND server_id = $2`,
		userID, serverID,
	)
	if err != nil {
		return fmt.Errorf("delete member: %w", err)
	}
	return nil
}

func (s *ChatStore) IsMember(ctx context.Context, userID, serverID string) (bool, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	var exists bool
	err := s.pool.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM members WHERE user_id = $1 AND server_id = $2)`,
		userID, serverID,
	).Scan(&exists)
	if err != nil {
		return false, fmt.Errorf("check membership: %w", err)
	}
	return exists, nil
}

func (s *ChatStore) GetMemberCount(ctx context.Context, serverID string) (int, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	var count int
	err := s.pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM members WHERE server_id = $1`, serverID,
	).Scan(&count)
	if err != nil {
		return 0, fmt.Errorf("count members: %w", err)
	}
	return count, nil
}


func (s *ChatStore) GetChannelAndCheckMembership(ctx context.Context, channelID, userID string) (*models.Channel, bool, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	var ch models.Channel
	var isMember bool
	err := s.pool.QueryRow(ctx,
		`SELECT c.id, COALESCE(c.server_id, ''), c.name, c.type, c.topic, c.position, c.is_private, c.slow_mode_seconds, c.is_default, COALESCE(c.channel_group_id, ''), c.dm_status, COALESCE(c.dm_initiator_id, ''), c.content_warning, COALESCE(c.voice_text_channel_id, ''), c.permissions_synced, c.created_at,
		        CASE
		          WHEN c.type IN (3, 4) THEN EXISTS(SELECT 1 FROM channel_members cm WHERE cm.channel_id = c.id AND cm.user_id = $2)
		          ELSE EXISTS(SELECT 1 FROM members m WHERE m.user_id = $2 AND m.server_id = c.server_id)
		        END
		 FROM channels c
		 WHERE c.id = $1`,
		channelID, userID,
	).Scan(&ch.ID, &ch.ServerID, &ch.Name, &ch.Type, &ch.Topic, &ch.Position, &ch.IsPrivate, &ch.SlowModeSeconds, &ch.IsDefault, &ch.ChannelGroupID, &ch.DMStatus, &ch.DMInitiatorID, &ch.ContentWarning, &ch.VoiceTextChannelID, &ch.PermissionsSynced, &ch.CreatedAt, &isMember)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, false, fmt.Errorf("channel not found")
		}
		return nil, false, fmt.Errorf("query channel membership: %w", err)
	}
	return &ch, isMember, nil
}

func (s *ChatStore) GetMember(ctx context.Context, userID, serverID string) (*models.Member, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	var m models.Member
	err := s.pool.QueryRow(ctx,
		`SELECT m.user_id, m.server_id, m.joined_at, m.timed_out_until,
		        COALESCE(NULLIF(m.nickname, ''), NULLIF(u.display_name, ''), u.username, '') AS nickname,
		        COALESCE(ARRAY_AGG(mr.role_id) FILTER (WHERE mr.role_id IS NOT NULL), '{}'),
		        m.onboarding_completed_at, m.rules_acknowledged_at
		 FROM members m
		 JOIN users u ON u.id = m.user_id
		 LEFT JOIN member_roles mr ON mr.user_id = m.user_id AND mr.server_id = m.server_id
		 WHERE m.user_id = $1 AND m.server_id = $2
		 GROUP BY m.user_id, m.server_id, m.joined_at, m.timed_out_until, m.nickname,
		          m.onboarding_completed_at, m.rules_acknowledged_at, u.display_name, u.username`,
		userID, serverID,
	).Scan(&m.UserID, &m.ServerID, &m.JoinedAt, &m.TimedOutUntil, &m.Nickname, &m.RoleIDs,
		&m.OnboardingCompletedAt, &m.RulesAcknowledgedAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, fmt.Errorf("member not found")
		}
		return nil, fmt.Errorf("query member: %w", err)
	}
	return &m, nil
}

func (s *ChatStore) ListMembers(ctx context.Context, serverID string, after string, limit int) ([]*models.Member, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	if limit <= 0 || limit > 200 {
		limit = 200
	}

	rows, err := s.pool.Query(ctx,
		`SELECT m.user_id, m.server_id, m.joined_at, m.timed_out_until,
		        COALESCE(NULLIF(m.nickname, ''), NULLIF(u.display_name, ''), u.username, '') AS nickname,
		        COALESCE(ARRAY_AGG(mr.role_id) FILTER (WHERE mr.role_id IS NOT NULL), '{}'),
		        m.onboarding_completed_at, m.rules_acknowledged_at
		 FROM members m
		 JOIN users u ON u.id = m.user_id
		 LEFT JOIN member_roles mr ON mr.user_id = m.user_id AND mr.server_id = m.server_id
		 WHERE m.server_id = $1 AND m.user_id > $2
		 GROUP BY m.user_id, m.server_id, m.joined_at, m.timed_out_until, m.nickname,
		          m.onboarding_completed_at, m.rules_acknowledged_at, u.display_name, u.username
		 ORDER BY m.user_id
		 LIMIT $3`,
		serverID, after, limit,
	)
	if err != nil {
		return nil, fmt.Errorf("query members: %w", err)
	}
	defer rows.Close()

	var members []*models.Member
	for rows.Next() {
		var m models.Member
		if err := rows.Scan(&m.UserID, &m.ServerID, &m.JoinedAt, &m.TimedOutUntil, &m.Nickname, &m.RoleIDs,
			&m.OnboardingCompletedAt, &m.RulesAcknowledgedAt); err != nil {
			return nil, fmt.Errorf("scan member: %w", err)
		}
		members = append(members, &m)
	}
	return members, rows.Err()
}

// ListMemberUserIDs returns just the user IDs for all members of a server.
// This is much cheaper than ListMembers which JOINs users, roles, etc.
func (s *ChatStore) ListMemberUserIDs(ctx context.Context, serverID string) ([]string, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	rows, err := s.pool.Query(ctx,
		`SELECT user_id FROM members WHERE server_id = $1`, serverID,
	)
	if err != nil {
		return nil, fmt.Errorf("query member user IDs: %w", err)
	}
	defer rows.Close()

	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("scan member user ID: %w", err)
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

func (s *ChatStore) GetUserChannels(ctx context.Context, userID string) ([]string, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	// Return server channels the user can see, plus DM/group DM channels.
	// For server channels: include all public channels, but only include
	// private channels if the user is a channel member or the server owner.
	// This prevents the gateway from subscribing users to private channels
	// they lack ViewChannel on, which would leak message metadata.
	rows, err := s.pool.Query(ctx,
		`SELECT c.id FROM channels c
		 JOIN members m ON m.server_id = c.server_id
		 LEFT JOIN channel_members cm ON cm.channel_id = c.id AND cm.user_id = $1
		 LEFT JOIN servers s ON s.id = c.server_id
		 WHERE m.user_id = $1
		   AND (c.is_private = false OR cm.channel_id IS NOT NULL OR s.owner_id = $1)
		 UNION
		 SELECT c.id FROM channels c
		 JOIN channel_members cm ON cm.channel_id = c.id
		 WHERE cm.user_id = $1 AND c.type IN (3, 4)`, userID,
	)
	if err != nil {
		return nil, fmt.Errorf("query user channels: %w", err)
	}
	defer rows.Close()

	var channelIDs []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("scan channel id: %w", err)
		}
		channelIDs = append(channelIDs, id)
	}
	return channelIDs, nil
}

func (s *ChatStore) AddChannelMember(ctx context.Context, channelID, userID string) error {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	_, err := s.pool.Exec(ctx,
		`INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)
		 ON CONFLICT (channel_id, user_id) DO NOTHING`,
		channelID, userID,
	)
	if err != nil {
		return fmt.Errorf("insert channel member: %w", err)
	}
	return nil
}

func (s *ChatStore) RemoveChannelMember(ctx context.Context, channelID, userID string) error {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx)

	_, err = tx.Exec(ctx,
		`DELETE FROM channel_members WHERE channel_id = $1 AND user_id = $2`,
		channelID, userID,
	)
	if err != nil {
		return fmt.Errorf("delete channel member: %w", err)
	}

	// Clean up key envelopes so removed users don't leave orphaned E2EE data.
	_, err = tx.Exec(ctx,
		`DELETE FROM channel_key_envelopes WHERE channel_id = $1 AND user_id = $2`,
		channelID, userID,
	)
	if err != nil {
		return fmt.Errorf("delete channel key envelopes: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit tx: %w", err)
	}
	return nil
}

func (s *ChatStore) ListChannelMembers(ctx context.Context, channelID string) ([]*models.Member, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	// Get channel's server_id first, then join with members to return full Member data.
	rows, err := s.pool.Query(ctx,
		`SELECT m.user_id, m.server_id, m.joined_at, m.timed_out_until,
		        COALESCE(NULLIF(m.nickname, ''), NULLIF(u.display_name, ''), u.username, '') AS nickname,
		        COALESCE(ARRAY_AGG(mr.role_id) FILTER (WHERE mr.role_id IS NOT NULL), '{}'),
		        m.onboarding_completed_at, m.rules_acknowledged_at
		 FROM channel_members cm
		 JOIN channels c ON c.id = cm.channel_id
		 JOIN members m ON m.user_id = cm.user_id AND m.server_id = c.server_id
		 JOIN users u ON u.id = cm.user_id
		 LEFT JOIN member_roles mr ON mr.user_id = m.user_id AND mr.server_id = m.server_id
		 WHERE cm.channel_id = $1
		 GROUP BY m.user_id, m.server_id, m.joined_at, m.timed_out_until, m.nickname,
		          m.onboarding_completed_at, m.rules_acknowledged_at, u.display_name, u.username,
		          cm.added_at
		 ORDER BY cm.added_at`,
		channelID,
	)
	if err != nil {
		return nil, fmt.Errorf("query channel members: %w", err)
	}
	defer rows.Close()

	var members []*models.Member
	for rows.Next() {
		var m models.Member
		if err := rows.Scan(&m.UserID, &m.ServerID, &m.JoinedAt, &m.TimedOutUntil, &m.Nickname, &m.RoleIDs,
			&m.OnboardingCompletedAt, &m.RulesAcknowledgedAt); err != nil {
			return nil, fmt.Errorf("scan channel member: %w", err)
		}
		members = append(members, &m)
	}
	return members, rows.Err()
}

// ListChannelParticipantIDs returns just the user IDs for a channel's members.
// Unlike ListChannelMembers, this works for serverless channels (DMs, group DMs)
// because it queries channel_members directly without joining through the members table.
func (s *ChatStore) ListChannelParticipantIDs(ctx context.Context, channelID string) ([]string, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	rows, err := s.pool.Query(ctx,
		`SELECT user_id FROM channel_members WHERE channel_id = $1 ORDER BY added_at`,
		channelID,
	)
	if err != nil {
		return nil, fmt.Errorf("query channel participant IDs: %w", err)
	}
	defer rows.Close()

	var userIDs []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("scan channel participant ID: %w", err)
		}
		userIDs = append(userIDs, id)
	}
	return userIDs, rows.Err()
}

// CountChannelMembers returns the number of members in a channel.
func (s *ChatStore) CountChannelMembers(ctx context.Context, channelID string) (int, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	var count int
	err := s.pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM channel_members WHERE channel_id = $1`,
		channelID,
	).Scan(&count)
	if err != nil {
		return 0, fmt.Errorf("count channel members: %w", err)
	}
	return count, nil
}

func (s *ChatStore) IsChannelMember(ctx context.Context, channelID, userID string) (bool, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	var exists bool
	err := s.pool.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM channel_members WHERE channel_id = $1 AND user_id = $2)`,
		channelID, userID,
	).Scan(&exists)
	if err != nil {
		return false, fmt.Errorf("check channel membership: %w", err)
	}
	return exists, nil
}

// AreServerMembersOfChannel checks that every user ID in userIDs is a member
// of the server that owns the given channel. For DM channels (no server_id),
// it falls back to checking channel_members. Returns true only if the count
// matches the number of unique user IDs supplied.
func (s *ChatStore) AreServerMembersOfChannel(ctx context.Context, channelID string, userIDs []string) (bool, error) {
	if len(userIDs) == 0 {
		return true, nil
	}

	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	// Deduplicate input.
	unique := make(map[string]struct{}, len(userIDs))
	for _, id := range userIDs {
		unique[id] = struct{}{}
	}

	// Try server membership first (server channels).
	var count int
	err := s.pool.QueryRow(ctx,
		`SELECT COUNT(DISTINCT m.user_id)
		   FROM members m
		   JOIN channels c ON c.server_id = m.server_id
		  WHERE c.id = $1 AND m.user_id = ANY($2)`,
		channelID, userIDs,
	).Scan(&count)
	if err != nil {
		return false, fmt.Errorf("check server membership for envelope recipients: %w", err)
	}
	if count == len(unique) {
		return true, nil
	}

	// Fallback for DM channels: check channel_members instead.
	err = s.pool.QueryRow(ctx,
		`SELECT COUNT(DISTINCT cm.user_id)
		   FROM channel_members cm
		  WHERE cm.channel_id = $1 AND cm.user_id = ANY($2)`,
		channelID, userIDs,
	).Scan(&count)
	if err != nil {
		return false, fmt.Errorf("check channel membership for envelope recipients: %w", err)
	}
	return count == len(unique), nil
}

func (s *ChatStore) RemoveChannelMembersForServer(ctx context.Context, userID, serverID string) error {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx)

	// Delete channel_members rows.
	_, err = tx.Exec(ctx,
		`DELETE FROM channel_members cm
		 USING channels c
		 WHERE cm.channel_id = c.id AND c.server_id = $1 AND cm.user_id = $2`,
		serverID, userID,
	)
	if err != nil {
		return fmt.Errorf("remove channel members for server: %w", err)
	}

	// Delete channel_key_envelopes rows for the user's channels in this server.
	_, err = tx.Exec(ctx,
		`DELETE FROM channel_key_envelopes cke
		 USING channels c
		 WHERE cke.channel_id = c.id AND c.server_id = $1 AND cke.user_id = $2`,
		serverID, userID,
	)
	if err != nil {
		return fmt.Errorf("remove key envelopes for server: %w", err)
	}

	return tx.Commit(ctx)
}

func (s *ChatStore) SetMemberTimeout(ctx context.Context, serverID, userID string, timedOutUntil *time.Time) error {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	result, err := s.pool.Exec(ctx,
		`UPDATE members SET timed_out_until = $1 WHERE server_id = $2 AND user_id = $3`,
		timedOutUntil, serverID, userID,
	)
	if err != nil {
		return fmt.Errorf("set member timeout: %w", err)
	}
	if result.RowsAffected() == 0 {
		return fmt.Errorf("member not found")
	}
	return nil
}

func (s *ChatStore) SetMemberNickname(ctx context.Context, serverID, userID, nickname string) error {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	result, err := s.pool.Exec(ctx,
		`UPDATE members SET nickname = $1 WHERE server_id = $2 AND user_id = $3`,
		nickname, serverID, userID,
	)
	if err != nil {
		return fmt.Errorf("set member nickname: %w", err)
	}
	if result.RowsAffected() == 0 {
		return fmt.Errorf("member not found")
	}
	return nil
}

func (s *ChatStore) ClearChannelMembers(ctx context.Context, channelID string) error {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	_, err := s.pool.Exec(ctx,
		`DELETE FROM channel_members WHERE channel_id = $1`, channelID,
	)
	if err != nil {
		return fmt.Errorf("clear channel members: %w", err)
	}
	return nil
}

// dmPairKey returns a deterministic key for a pair of user IDs, used to prevent
// duplicate DM channels between the same two users.
func dmPairKey(userID1, userID2 string) string {
	if userID1 < userID2 {
		return userID1 + ":" + userID2
	}
	return userID2 + ":" + userID1
}

func (s *ChatStore) CreateDMChannel(ctx context.Context, userID1, userID2, dmStatus, dmInitiatorID string) (*models.Channel, bool, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	pairKey := dmPairKey(userID1, userID2)

	// Try to find existing DM channel first (fast path, no transaction needed).
	var ch models.Channel
	err := s.pool.QueryRow(ctx,
		`SELECT id, COALESCE(server_id, ''), name, type, topic, position, is_private, dm_status, COALESCE(dm_initiator_id, ''), content_warning, COALESCE(voice_text_channel_id, ''), created_at
		 FROM channels WHERE dm_pair_key = $1`, pairKey,
	).Scan(&ch.ID, &ch.ServerID, &ch.Name, &ch.Type, &ch.Topic, &ch.Position, &ch.IsPrivate, &ch.DMStatus, &ch.DMInitiatorID, &ch.ContentWarning, &ch.VoiceTextChannelID, &ch.CreatedAt)
	if err == nil {
		return &ch, false, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return nil, false, fmt.Errorf("lookup dm channel: %w", err)
	}

	// Create new DM channel in a transaction.
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, false, fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx)

	channelID := models.NewID()
	now := time.Now()

	// INSERT ... ON CONFLICT handles the race where two users create simultaneously.
	var initiatorParam *string
	if dmInitiatorID != "" {
		initiatorParam = &dmInitiatorID
	}
	err = tx.QueryRow(ctx,
		`INSERT INTO channels (id, name, type, is_private, dm_pair_key, dm_status, dm_initiator_id, created_at)
		 VALUES ($1, 'dm', 3, true, $2, $3, $4, $5)
		 ON CONFLICT (dm_pair_key) WHERE dm_pair_key IS NOT NULL
		 DO UPDATE SET id = channels.id
		 RETURNING id, COALESCE(server_id, ''), name, type, topic, position, is_private, dm_status, COALESCE(dm_initiator_id, ''), content_warning, COALESCE(voice_text_channel_id, ''), created_at`,
		channelID, pairKey, dmStatus, initiatorParam, now,
	).Scan(&ch.ID, &ch.ServerID, &ch.Name, &ch.Type, &ch.Topic, &ch.Position, &ch.IsPrivate, &ch.DMStatus, &ch.DMInitiatorID, &ch.ContentWarning, &ch.VoiceTextChannelID, &ch.CreatedAt)
	if err != nil {
		return nil, false, fmt.Errorf("insert dm channel: %w", err)
	}

	// If the returned ID differs from what we tried to insert, the channel already existed.
	created := ch.ID == channelID
	if created {
		_, err = tx.Exec(ctx,
			`INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2), ($1, $3)
			 ON CONFLICT (channel_id, user_id) DO NOTHING`,
			channelID, userID1, userID2,
		)
		if err != nil {
			return nil, false, fmt.Errorf("insert dm participants: %w", err)
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, false, fmt.Errorf("commit tx: %w", err)
	}
	return &ch, created, nil
}

func (s *ChatStore) CreateGroupDMChannel(ctx context.Context, creatorID, name string, participantIDs []string) (*models.Channel, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx)

	channelID := models.NewID()
	now := time.Now()
	if name == "" {
		name = "Group DM"
	}

	var ch models.Channel
	err = tx.QueryRow(ctx,
		`INSERT INTO channels (id, name, type, is_private, dm_status, dm_initiator_id, created_at)
		 VALUES ($1, $2, 4, true, 'active', $3, $4)
		 RETURNING id, COALESCE(server_id, ''), name, type, topic, position, is_private, dm_status, COALESCE(dm_initiator_id, ''), content_warning, COALESCE(voice_text_channel_id, ''), created_at`,
		channelID, name, creatorID, now,
	).Scan(&ch.ID, &ch.ServerID, &ch.Name, &ch.Type, &ch.Topic, &ch.Position, &ch.IsPrivate, &ch.DMStatus, &ch.DMInitiatorID, &ch.ContentWarning, &ch.VoiceTextChannelID, &ch.CreatedAt)
	if err != nil {
		return nil, fmt.Errorf("insert group dm channel: %w", err)
	}

	for _, uid := range participantIDs {
		_, err = tx.Exec(ctx,
			`INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)`,
			channelID, uid,
		)
		if err != nil {
			return nil, fmt.Errorf("insert group dm participant %s: %w", uid, err)
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit tx: %w", err)
	}
	return &ch, nil
}

func (s *ChatStore) GetDMChannelByPairKey(ctx context.Context, userID1, userID2 string) (*models.Channel, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	pairKey := dmPairKey(userID1, userID2)
	var ch models.Channel
	err := s.pool.QueryRow(ctx,
		`SELECT id, COALESCE(server_id, ''), name, type, topic, position, is_private, dm_status, COALESCE(dm_initiator_id, ''), content_warning, COALESCE(voice_text_channel_id, ''), created_at
		 FROM channels WHERE dm_pair_key = $1`, pairKey,
	).Scan(&ch.ID, &ch.ServerID, &ch.Name, &ch.Type, &ch.Topic, &ch.Position, &ch.IsPrivate, &ch.DMStatus, &ch.DMInitiatorID, &ch.ContentWarning, &ch.VoiceTextChannelID, &ch.CreatedAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, fmt.Errorf("lookup dm channel by pair key: %w", err)
	}
	return &ch, nil
}

func (s *ChatStore) UpdateDMStatus(ctx context.Context, channelID, status string) error {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	_, err := s.pool.Exec(ctx,
		`UPDATE channels SET dm_status = $2 WHERE id = $1`,
		channelID, status,
	)
	if err != nil {
		return fmt.Errorf("update dm status: %w", err)
	}
	return nil
}

func (s *ChatStore) ShareAnyServer(ctx context.Context, userID1, userID2 string) (bool, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	var exists bool
	err := s.pool.QueryRow(ctx,
		`SELECT EXISTS(
			SELECT 1 FROM members m1
			JOIN members m2 ON m1.server_id = m2.server_id
			WHERE m1.user_id = $1 AND m2.user_id = $2
		)`,
		userID1, userID2,
	).Scan(&exists)
	if err != nil {
		return false, fmt.Errorf("check shared server: %w", err)
	}
	return exists, nil
}

func (s *ChatStore) GetMutualServers(ctx context.Context, userID1, userID2 string) ([]*models.Server, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	rows, err := s.pool.Query(ctx,
		`SELECT s.id, s.name, COALESCE(s.icon_url,''), s.owner_id, s.created_at
		 FROM servers s
		 JOIN members m1 ON m1.server_id = s.id AND m1.user_id = $1
		 JOIN members m2 ON m2.server_id = s.id AND m2.user_id = $2
		 ORDER BY s.name
		 LIMIT 50`,
		userID1, userID2,
	)
	if err != nil {
		return nil, fmt.Errorf("query mutual servers: %w", err)
	}
	defer rows.Close()

	var servers []*models.Server
	for rows.Next() {
		var srv models.Server
		if err := rows.Scan(&srv.ID, &srv.Name, &srv.IconURL, &srv.OwnerID, &srv.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan server: %w", err)
		}
		servers = append(servers, &srv)
	}
	return servers, rows.Err()
}

// GetDMOtherParticipantID returns the other participant's user ID in a DM channel.
// The caller must already be a confirmed member of the channel (e.g. via GetChannelAndCheckMembership).
// If no other member exists, it returns userID itself, indicating a self-DM.
func (s *ChatStore) GetDMOtherParticipantID(ctx context.Context, channelID, userID string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	var otherID string
	err := s.pool.QueryRow(ctx,
		`SELECT user_id FROM channel_members WHERE channel_id = $1 AND user_id != $2 LIMIT 1`,
		channelID, userID,
	).Scan(&otherID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			// Self-DM: only member is the caller themselves.
			return userID, nil
		}
		return "", fmt.Errorf("get DM other participant: %w", err)
	}
	return otherID, nil
}

func (s *ChatStore) ListDMChannelsWithParticipants(ctx context.Context, userID string) ([]*models.DMChannelWithParticipants, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	rows, err := s.pool.Query(ctx,
		`SELECT c.id, COALESCE(c.server_id, ''), c.name, c.type, c.topic, c.position, c.is_private, c.dm_status, COALESCE(c.dm_initiator_id, ''), c.content_warning, c.created_at,
		        u.id, u.username, COALESCE(u.display_name, ''), COALESCE(u.avatar_url, ''), u.emoji_scale, u.created_at
		 FROM channels c
		 JOIN channel_members my_cm ON my_cm.channel_id = c.id AND my_cm.user_id = $1
		 JOIN channel_members all_cm ON all_cm.channel_id = c.id
		 JOIN users u ON u.id = all_cm.user_id
		 WHERE c.type IN (3, 4) AND c.dm_status = 'active'
		 ORDER BY c.created_at DESC, c.id, u.id`, userID,
	)
	if err != nil {
		return nil, fmt.Errorf("query dm channels with participants: %w", err)
	}
	defer rows.Close()

	return scanDMChannelsWithParticipants(rows)
}

func (s *ChatStore) ListPendingDMRequests(ctx context.Context, recipientID string) ([]*models.DMChannelWithParticipants, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	rows, err := s.pool.Query(ctx,
		`SELECT c.id, COALESCE(c.server_id, ''), c.name, c.type, c.topic, c.position, c.is_private, c.dm_status, COALESCE(c.dm_initiator_id, ''), c.content_warning, c.created_at,
		        u.id, u.username, COALESCE(u.display_name, ''), COALESCE(u.avatar_url, ''), u.emoji_scale, u.created_at
		 FROM channels c
		 JOIN channel_members my_cm ON my_cm.channel_id = c.id AND my_cm.user_id = $1
		 JOIN channel_members all_cm ON all_cm.channel_id = c.id
		 JOIN users u ON u.id = all_cm.user_id
		 WHERE c.type = 3 AND c.dm_status = 'pending' AND c.dm_initiator_id != $1
		 ORDER BY c.created_at DESC, c.id, u.id`, recipientID,
	)
	if err != nil {
		return nil, fmt.Errorf("query pending dm requests: %w", err)
	}
	defer rows.Close()

	return scanDMChannelsWithParticipants(rows)
}

// scanDMChannelsWithParticipants groups rows by channel, building DMChannelWithParticipants.
func scanDMChannelsWithParticipants(rows pgx.Rows) ([]*models.DMChannelWithParticipants, error) {
	var result []*models.DMChannelWithParticipants
	var current *models.DMChannelWithParticipants

	for rows.Next() {
		var ch models.Channel
		var u models.User
		if err := rows.Scan(
			&ch.ID, &ch.ServerID, &ch.Name, &ch.Type, &ch.Topic, &ch.Position, &ch.IsPrivate, &ch.DMStatus, &ch.DMInitiatorID, &ch.ContentWarning, &ch.CreatedAt,
			&u.ID, &u.Username, &u.DisplayName, &u.AvatarURL, &u.EmojiScale, &u.CreatedAt,
		); err != nil {
			return nil, fmt.Errorf("scan dm channel with participant: %w", err)
		}

		if current == nil || current.Channel.ID != ch.ID {
			current = &models.DMChannelWithParticipants{Channel: ch}
			result = append(result, current)
		}
		current.Participants = append(current.Participants, u)
	}
	return result, rows.Err()
}

func (s *ChatStore) UpdateServer(ctx context.Context, serverID string, name, iconURL, welcomeMessage, rules *string, onboardingEnabled, rulesRequired, defaultChannelPrivacy *bool, bannerURL *string) (*models.Server, error) {
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
	if iconURL != nil {
		setClauses = append(setClauses, fmt.Sprintf("icon_url = $%d", argIdx))
		args = append(args, *iconURL)
		argIdx++
	}
	if welcomeMessage != nil {
		setClauses = append(setClauses, fmt.Sprintf("welcome_message = $%d", argIdx))
		args = append(args, *welcomeMessage)
		argIdx++
	}
	if rules != nil {
		setClauses = append(setClauses, fmt.Sprintf("rules = $%d", argIdx))
		args = append(args, *rules)
		argIdx++
	}
	if onboardingEnabled != nil {
		setClauses = append(setClauses, fmt.Sprintf("onboarding_enabled = $%d", argIdx))
		args = append(args, *onboardingEnabled)
		argIdx++
	}
	if rulesRequired != nil {
		setClauses = append(setClauses, fmt.Sprintf("rules_required = $%d", argIdx))
		args = append(args, *rulesRequired)
		argIdx++
	}
	if defaultChannelPrivacy != nil {
		setClauses = append(setClauses, fmt.Sprintf("default_channel_privacy = $%d", argIdx))
		args = append(args, *defaultChannelPrivacy)
		argIdx++
	}
	if bannerURL != nil {
		setClauses = append(setClauses, fmt.Sprintf("banner_url = $%d", argIdx))
		args = append(args, *bannerURL)
		argIdx++
	}

	if len(setClauses) == 0 {
		return s.GetServer(ctx, serverID)
	}

	query := fmt.Sprintf(
		"UPDATE servers SET %s WHERE id = $%d RETURNING id, name, icon_url, owner_id, created_at, welcome_message, rules, onboarding_enabled, rules_required, default_channel_privacy, banner_url",
		strings.Join(setClauses, ", "),
		argIdx,
	)
	args = append(args, serverID)

	var srv models.Server
	err := s.pool.QueryRow(ctx, query, args...).Scan(
		&srv.ID, &srv.Name, &srv.IconURL, &srv.OwnerID, &srv.CreatedAt,
		&srv.WelcomeMessage, &srv.Rules, &srv.OnboardingEnabled, &srv.RulesRequired, &srv.DefaultChannelPrivacy, &srv.BannerURL,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, fmt.Errorf("server not found")
		}
		return nil, fmt.Errorf("update server: %w", err)
	}
	return &srv, nil
}

func (s *ChatStore) AcknowledgeRules(ctx context.Context, userID, serverID string) (time.Time, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	now := time.Now()
	result, err := s.pool.Exec(ctx,
		`UPDATE members SET rules_acknowledged_at = $1 WHERE user_id = $2 AND server_id = $3`,
		now, userID, serverID,
	)
	if err != nil {
		return time.Time{}, fmt.Errorf("acknowledge rules: %w", err)
	}
	if result.RowsAffected() == 0 {
		return time.Time{}, fmt.Errorf("member not found")
	}
	return now, nil
}

func (s *ChatStore) CompleteOnboarding(ctx context.Context, userID, serverID string, channelIDs, roleIDs []string) (time.Time, []string, []string, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return time.Time{}, nil, nil, fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx)

	now := time.Now()

	// Set onboarding completed timestamp.
	_, err = tx.Exec(ctx,
		`UPDATE members SET onboarding_completed_at = $1 WHERE user_id = $2 AND server_id = $3`,
		now, userID, serverID,
	)
	if err != nil {
		return time.Time{}, nil, nil, fmt.Errorf("set onboarding completed: %w", err)
	}

	// Validate and join channels (skip invalid/private).
	var skippedChannelIDs []string
	if len(channelIDs) > 0 {
		rows, err := tx.Query(ctx,
			`SELECT id FROM channels WHERE id = ANY($1) AND server_id = $2 AND is_private = false`,
			channelIDs, serverID,
		)
		if err != nil {
			return time.Time{}, nil, nil, fmt.Errorf("validate channels: %w", err)
		}
		validChannels := make(map[string]bool)
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err != nil {
				rows.Close()
				return time.Time{}, nil, nil, fmt.Errorf("scan channel id: %w", err)
			}
			validChannels[id] = true
		}
		rows.Close()

		for _, id := range channelIDs {
			if !validChannels[id] {
				skippedChannelIDs = append(skippedChannelIDs, id)
			}
		}

		// Join valid channels.
		var validIDs []string
		for id := range validChannels {
			validIDs = append(validIDs, id)
		}
		if len(validIDs) > 0 {
			_, err = tx.Exec(ctx,
				`INSERT INTO channel_members (channel_id, user_id)
				 SELECT unnest($1::text[]), $2
				 ON CONFLICT (channel_id, user_id) DO NOTHING`,
				validIDs, userID,
			)
			if err != nil {
				return time.Time{}, nil, nil, fmt.Errorf("join channels: %w", err)
			}
		}
	}

	// Validate and assign roles (skip invalid/non-self-assignable).
	var skippedRoleIDs []string
	if len(roleIDs) > 0 {
		rows, err := tx.Query(ctx,
			`SELECT id FROM roles WHERE id = ANY($1) AND server_id = $2 AND is_self_assignable = true`,
			roleIDs, serverID,
		)
		if err != nil {
			return time.Time{}, nil, nil, fmt.Errorf("validate roles: %w", err)
		}
		validRoles := make(map[string]bool)
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err != nil {
				rows.Close()
				return time.Time{}, nil, nil, fmt.Errorf("scan role id: %w", err)
			}
			validRoles[id] = true
		}
		rows.Close()

		for _, id := range roleIDs {
			if !validRoles[id] {
				skippedRoleIDs = append(skippedRoleIDs, id)
			}
		}

		// Assign valid roles.
		var validIDs []string
		for id := range validRoles {
			validIDs = append(validIDs, id)
		}
		if len(validIDs) > 0 {
			_, err = tx.Exec(ctx,
				`INSERT INTO member_roles (user_id, server_id, role_id)
				 SELECT $1, $2, unnest($3::text[])
				 ON CONFLICT (user_id, server_id, role_id) DO NOTHING`,
				userID, serverID, validIDs,
			)
			if err != nil {
				return time.Time{}, nil, nil, fmt.Errorf("assign roles: %w", err)
			}
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return time.Time{}, nil, nil, fmt.Errorf("commit tx: %w", err)
	}

	return now, skippedChannelIDs, skippedRoleIDs, nil
}

func (s *ChatStore) CheckRulesAcknowledged(ctx context.Context, userID, serverID string) (bool, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	var acknowledged bool
	err := s.pool.QueryRow(ctx,
		`SELECT rules_acknowledged_at IS NOT NULL FROM members WHERE user_id = $1 AND server_id = $2`,
		userID, serverID,
	).Scan(&acknowledged)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return false, fmt.Errorf("member not found")
		}
		return false, fmt.Errorf("check rules acknowledged: %w", err)
	}
	return acknowledged, nil
}

func (s *ChatStore) GetDefaultChannels(ctx context.Context, serverID string) ([]*models.Channel, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	rows, err := s.pool.Query(ctx,
		`SELECT id, COALESCE(server_id, ''), name, type, topic, position, is_private, slow_mode_seconds, is_default, COALESCE(channel_group_id, ''), dm_status, COALESCE(dm_initiator_id, ''), content_warning, COALESCE(voice_text_channel_id, ''), permissions_synced, created_at
		 FROM channels WHERE server_id = $1 AND is_default = true AND is_private = false
		 ORDER BY position`, serverID,
	)
	if err != nil {
		return nil, fmt.Errorf("query default channels: %w", err)
	}
	defer rows.Close()

	var channels []*models.Channel
	for rows.Next() {
		var ch models.Channel
		if err := rows.Scan(&ch.ID, &ch.ServerID, &ch.Name, &ch.Type, &ch.Topic, &ch.Position, &ch.IsPrivate, &ch.SlowModeSeconds, &ch.IsDefault, &ch.ChannelGroupID, &ch.DMStatus, &ch.DMInitiatorID, &ch.ContentWarning, &ch.VoiceTextChannelID, &ch.PermissionsSynced, &ch.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan default channel: %w", err)
		}
		channels = append(channels, &ch)
	}
	return channels, rows.Err()
}

func (s *ChatStore) GetSelfAssignableRoles(ctx context.Context, serverID string) ([]*models.Role, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	rows, err := s.pool.Query(ctx,
		`SELECT id, server_id, name, permissions, color, position, is_self_assignable, created_at
		 FROM roles WHERE server_id = $1 AND is_self_assignable = true
		 ORDER BY position DESC`, serverID,
	)
	if err != nil {
		return nil, fmt.Errorf("query self-assignable roles: %w", err)
	}
	defer rows.Close()

	var roles []*models.Role
	for rows.Next() {
		var r models.Role
		if err := rows.Scan(&r.ID, &r.ServerID, &r.Name, &r.Permissions, &r.Color, &r.Position, &r.IsSelfAssignable, &r.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan self-assignable role: %w", err)
		}
		roles = append(roles, &r)
	}
	return roles, rows.Err()
}

// CreateServerFromTemplateParams holds all parameters for creating a server from a template.
type CreateServerFromTemplateParams struct {
	Name                  string
	IconURL               *string
	OwnerID               string
	WelcomeMessage        *string
	Rules                 *string
	OnboardingEnabled     bool
	RulesRequired         bool
	DefaultChannelPrivacy bool
	Channels              []TemplateChannelSpec
	Roles                 []TemplateRoleSpec
	// EveryonePermissions overrides the default @everyone permission set when
	// non-nil. A nil pointer means "use permissions.DefaultEveryonePermissions".
	EveryonePermissions *int64
	// ChannelGroups are created in declared order before channels. Each
	// ChannelSpec.GroupName is resolved to a group ID at creation time.
	ChannelGroups []TemplateChannelGroupSpec
}

// TemplateChannelSpec describes a channel to create with the server.
type TemplateChannelSpec struct {
	Name      string
	Type      int
	IsDefault bool
	IsPrivate bool
	RoleNames []string // roles (by name) that get access to this private channel
	// GroupName matches a TemplateChannelGroupSpec.Name declared on the same
	// request. An empty string or unmatched name means the channel is ungrouped.
	GroupName string
}

// TemplateChannelGroupSpec describes a channel category to create with the server.
type TemplateChannelGroupSpec struct {
	Name string
}

// TemplateRoleSpec describes a role to create with the server.
type TemplateRoleSpec struct {
	Name             string
	Permissions      int64
	Color            int
	IsSelfAssignable bool
}

func (s *ChatStore) CreateServerFromTemplate(ctx context.Context, params CreateServerFromTemplateParams) (*models.Server, []*models.Channel, []*models.Role, []*models.ChannelGroup, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, nil, nil, nil, fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx)

	now := time.Now()
	serverID := models.NewID()

	// Insert server.
	_, err = tx.Exec(ctx,
		`INSERT INTO servers (id, name, icon_url, owner_id, created_at, welcome_message, rules, onboarding_enabled, rules_required, default_channel_privacy)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
		serverID, params.Name, params.IconURL, params.OwnerID, now,
		params.WelcomeMessage, params.Rules, params.OnboardingEnabled, params.RulesRequired, params.DefaultChannelPrivacy,
	)
	if err != nil {
		return nil, nil, nil, nil, fmt.Errorf("insert server: %w", err)
	}

	// Insert creator as member.
	_, err = tx.Exec(ctx,
		`INSERT INTO members (user_id, server_id, joined_at) VALUES ($1, $2, $3)`,
		params.OwnerID, serverID, now,
	)
	if err != nil {
		return nil, nil, nil, nil, fmt.Errorf("insert member: %w", err)
	}

	// Create @everyone role (id = serverID, position 0). Use the template's
	// override permission set if provided; otherwise fall back to the default.
	everyonePerms := permissions.DefaultEveryonePermissions
	if params.EveryonePermissions != nil {
		everyonePerms = *params.EveryonePermissions
	}
	_, err = tx.Exec(ctx,
		`INSERT INTO roles (id, server_id, name, permissions, color, position, created_at)
		 VALUES ($1, $1, '@everyone', $2, 0, 0, $3)`,
		serverID, everyonePerms, now,
	)
	if err != nil {
		return nil, nil, nil, nil, fmt.Errorf("insert everyone role: %w", err)
	}

	// Insert channel groups in declared order, building a name → ID lookup
	// so channels can resolve their group assignment below.
	groupIDByName := make(map[string]string, len(params.ChannelGroups))
	createdGroups := make([]*models.ChannelGroup, 0, len(params.ChannelGroups))
	for i, g := range params.ChannelGroups {
		groupID := models.NewID()
		cg := &models.ChannelGroup{
			ID:        groupID,
			ServerID:  serverID,
			Name:      g.Name,
			Position:  i,
			CreatedAt: now,
		}
		_, err = tx.Exec(ctx,
			`INSERT INTO channel_groups (id, server_id, name, position, created_at)
			 VALUES ($1, $2, $3, $4, $5)`,
			cg.ID, cg.ServerID, cg.Name, cg.Position, cg.CreatedAt,
		)
		if err != nil {
			return nil, nil, nil, nil, fmt.Errorf("insert channel group %q: %w", g.Name, err)
		}
		groupIDByName[g.Name] = cg.ID
		createdGroups = append(createdGroups, cg)
	}

	// Insert channels.
	var channels []*models.Channel
	for i, spec := range params.Channels {
		chID := models.NewID()

		// Resolve group name → ID. An unmatched or empty name means the channel
		// is ungrouped (NULL channel_group_id). Empty string = ungrouped,
		// matching the existing convention elsewhere in this store.
		groupIDStr := groupIDByName[spec.GroupName]
		var groupIDSQL any // nil → SQL NULL via pgx
		if groupIDStr != "" {
			groupIDSQL = groupIDStr
		}

		// permissions_synced invariant: true iff the channel has a group AND
		// has no per-channel overrides. Private channels with RoleNames get
		// overrides created in the loop below, so they must land with
		// permissions_synced = false even when grouped.
		permSynced := groupIDStr != ""
		if spec.IsPrivate && len(spec.RoleNames) > 0 {
			permSynced = false
		}

		if spec.Type == 2 { // CHANNEL_TYPE_VOICE — create with companion text channel.
			textID := models.NewID()
			// Create companion text channel FIRST so the FK reference from the voice channel is valid.
			_, err = tx.Exec(ctx,
				`INSERT INTO channels (id, server_id, name, type, position, is_private, is_default, channel_group_id, permissions_synced, created_at)
				 VALUES ($1, $2, $3, 1, $4, $5, false, $6, $7, $8)`,
				textID, serverID, spec.Name, i, spec.IsPrivate, groupIDSQL, permSynced, now,
			)
			if err != nil {
				return nil, nil, nil, nil, fmt.Errorf("insert companion text channel for %q: %w", spec.Name, err)
			}
			_, err = tx.Exec(ctx,
				`INSERT INTO channels (id, server_id, name, type, position, is_private, is_default, channel_group_id, voice_text_channel_id, permissions_synced, created_at)
				 VALUES ($1, $2, $3, 2, $4, $5, $6, $7, $8, $9, $10)`,
				chID, serverID, spec.Name, i, spec.IsPrivate, spec.IsDefault, groupIDSQL, textID, permSynced, now,
			)
			if err != nil {
				return nil, nil, nil, nil, fmt.Errorf("insert voice channel %q: %w", spec.Name, err)
			}
			voiceCh := &models.Channel{
				ID:                 chID,
				ServerID:           serverID,
				Name:               spec.Name,
				Type:               2,
				Position:           i,
				IsPrivate:          spec.IsPrivate,
				IsDefault:          spec.IsDefault,
				ChannelGroupID:     groupIDStr,
				VoiceTextChannelID: textID,
				PermissionsSynced:  permSynced,
				CreatedAt:          now,
			}
			channels = append(channels, voiceCh)
			// Include companion in returned channels for key distribution.
			textCh := &models.Channel{
				ID:                textID,
				ServerID:          serverID,
				Name:              spec.Name,
				Type:              1,
				Position:          i,
				IsPrivate:         spec.IsPrivate,
				ChannelGroupID:    groupIDStr,
				PermissionsSynced: permSynced,
				CreatedAt:         now,
			}
			channels = append(channels, textCh)
		} else {
			_, err = tx.Exec(ctx,
				`INSERT INTO channels (id, server_id, name, type, position, is_private, is_default, channel_group_id, permissions_synced, created_at)
				 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
				chID, serverID, spec.Name, spec.Type, i, spec.IsPrivate, spec.IsDefault, groupIDSQL, permSynced, now,
			)
			if err != nil {
				return nil, nil, nil, nil, fmt.Errorf("insert channel %q: %w", spec.Name, err)
			}
			ch := &models.Channel{
				ID:                chID,
				ServerID:          serverID,
				Name:              spec.Name,
				Type:              spec.Type,
				Position:          i,
				IsPrivate:         spec.IsPrivate,
				IsDefault:         spec.IsDefault,
				ChannelGroupID:    groupIDStr,
				PermissionsSynced: permSynced,
				CreatedAt:         now,
			}
			channels = append(channels, ch)
		}
	}

	// Insert roles. Position starts at 1 so custom roles don't collide with
	// @everyone (position 0) under the roles_server_position_unique constraint.
	var roles []*models.Role
	for i, spec := range params.Roles {
		pos := i + 1
		roleID := models.NewID()
		_, err = tx.Exec(ctx,
			`INSERT INTO roles (id, server_id, name, permissions, color, position, is_self_assignable, created_at)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
			roleID, serverID, spec.Name, spec.Permissions, spec.Color, pos, spec.IsSelfAssignable, now,
		)
		if err != nil {
			return nil, nil, nil, nil, fmt.Errorf("insert role %q: %w", spec.Name, err)
		}
		roles = append(roles, &models.Role{
			ID:               roleID,
			ServerID:         serverID,
			Name:             spec.Name,
			Permissions:      spec.Permissions,
			Color:            spec.Color,
			Position:         pos,
			IsSelfAssignable: spec.IsSelfAssignable,
			CreatedAt:        now,
		})
	}

	// Build role name → ID lookup for permission overrides.
	roleIDByName := make(map[string]string, len(roles))
	for _, r := range roles {
		roleIDByName[r.Name] = r.ID
	}

	// Create permission overrides for private channels with role restrictions.
	for _, ch := range channels {
		spec := params.Channels[ch.Position]
		if !spec.IsPrivate || len(spec.RoleNames) == 0 {
			continue
		}
		allow := permissions.ViewChannel | permissions.SendMessages
		for _, roleName := range spec.RoleNames {
			roleID, ok := roleIDByName[roleName]
			if !ok {
				continue
			}
			overrideID := models.NewID()
			_, err = tx.Exec(ctx,
				`INSERT INTO permission_overrides (id, channel_id, role_id, allow, deny)
				 VALUES ($1, $2, $3, $4, 0)`,
				overrideID, ch.ID, roleID, allow,
			)
			if err != nil {
				return nil, nil, nil, nil, fmt.Errorf("insert permission override for channel %q role %q: %w", ch.Name, roleName, err)
			}
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, nil, nil, nil, fmt.Errorf("commit tx: %w", err)
	}

	srv := &models.Server{
		ID:                    serverID,
		Name:                  params.Name,
		IconURL:               params.IconURL,
		OwnerID:               params.OwnerID,
		CreatedAt:             now,
		WelcomeMessage:        params.WelcomeMessage,
		Rules:                 params.Rules,
		OnboardingEnabled:     params.OnboardingEnabled,
		RulesRequired:         params.RulesRequired,
		DefaultChannelPrivacy: params.DefaultChannelPrivacy,
	}

	return srv, channels, roles, createdGroups, nil
}

// scanSystemMessageConfig is a helper column list for consistent scanning.
var systemMessageConfigColumns = `server_id, welcome_channel_id, mod_log_channel_id,
	join_enabled, join_template, leave_enabled, leave_template,
	kick_enabled, kick_template, ban_enabled, ban_template,
	timeout_enabled, timeout_template, updated_at`

func scanSystemMessageConfig(row interface{ Scan(...any) error }) (*models.ServerSystemMessageConfig, error) {
	var cfg models.ServerSystemMessageConfig
	err := row.Scan(
		&cfg.ServerID, &cfg.WelcomeChannelID, &cfg.ModLogChannelID,
		&cfg.JoinEnabled, &cfg.JoinTemplate, &cfg.LeaveEnabled, &cfg.LeaveTemplate,
		&cfg.KickEnabled, &cfg.KickTemplate, &cfg.BanEnabled, &cfg.BanTemplate,
		&cfg.TimeoutEnabled, &cfg.TimeoutTemplate, &cfg.UpdatedAt,
	)
	return &cfg, err
}

func (s *ChatStore) GetSystemMessageConfig(ctx context.Context, serverID string) (*models.ServerSystemMessageConfig, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	query := fmt.Sprintf("SELECT %s FROM server_system_message_config WHERE server_id = $1", systemMessageConfigColumns)
	cfg, err := scanSystemMessageConfig(s.pool.QueryRow(ctx, query, serverID))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil // no config row — use defaults
		}
		return nil, fmt.Errorf("get system message config: %w", err)
	}
	return cfg, nil
}

func (s *ChatStore) UpsertSystemMessageConfig(ctx context.Context, serverID string, opts UpsertSystemMessageConfigOpts) (*models.ServerSystemMessageConfig, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	// Build dynamic SET clause for the ON CONFLICT UPDATE.
	setClauses := []string{"updated_at = now()"}
	args := []any{serverID}
	argIdx := 2

	addOpt := func(col string, val any) {
		setClauses = append(setClauses, fmt.Sprintf("%s = $%d", col, argIdx))
		args = append(args, val)
		argIdx++
	}

	if opts.WelcomeChannelID != nil {
		addOpt("welcome_channel_id", *opts.WelcomeChannelID)
	}
	if opts.ModLogChannelID != nil {
		addOpt("mod_log_channel_id", *opts.ModLogChannelID)
	}
	if opts.JoinEnabled != nil {
		addOpt("join_enabled", *opts.JoinEnabled)
	}
	if opts.JoinTemplate != nil {
		addOpt("join_template", *opts.JoinTemplate)
	}
	if opts.LeaveEnabled != nil {
		addOpt("leave_enabled", *opts.LeaveEnabled)
	}
	if opts.LeaveTemplate != nil {
		addOpt("leave_template", *opts.LeaveTemplate)
	}
	if opts.KickEnabled != nil {
		addOpt("kick_enabled", *opts.KickEnabled)
	}
	if opts.KickTemplate != nil {
		addOpt("kick_template", *opts.KickTemplate)
	}
	if opts.BanEnabled != nil {
		addOpt("ban_enabled", *opts.BanEnabled)
	}
	if opts.BanTemplate != nil {
		addOpt("ban_template", *opts.BanTemplate)
	}
	if opts.TimeoutEnabled != nil {
		addOpt("timeout_enabled", *opts.TimeoutEnabled)
	}
	if opts.TimeoutTemplate != nil {
		addOpt("timeout_template", *opts.TimeoutTemplate)
	}

	query := fmt.Sprintf(
		`INSERT INTO server_system_message_config (server_id) VALUES ($1)
		 ON CONFLICT (server_id) DO UPDATE SET %s
		 RETURNING %s`,
		strings.Join(setClauses, ", "),
		systemMessageConfigColumns,
	)

	cfg, err := scanSystemMessageConfig(s.pool.QueryRow(ctx, query, args...))
	if err != nil {
		return nil, fmt.Errorf("upsert system message config: %w", err)
	}
	return cfg, nil
}
