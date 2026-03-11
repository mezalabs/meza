-- Consolidated initial schema for Meza.
-- All prior incremental migrations collapsed into final state for public release.

-- ============================================================================
-- Tables (ordered by foreign-key dependencies)
-- ============================================================================

-- Users --

CREATE TABLE IF NOT EXISTS users (
    id                      TEXT PRIMARY KEY,
    email                   TEXT NOT NULL,
    username                TEXT NOT NULL,
    display_name            TEXT,
    avatar_url              TEXT,
    banner_url              TEXT,
    bio                     TEXT,
    pronouns                TEXT,
    theme_color_primary     TEXT,
    theme_color_secondary   TEXT,
    emoji_scale             REAL NOT NULL DEFAULT 1.0,
    simple_mode             BOOLEAN NOT NULL DEFAULT false,
    audio_preferences       JSONB NOT NULL DEFAULT '{"noise_suppression": true, "echo_cancellation": true, "auto_gain_control": true}',
    dm_privacy              TEXT NOT NULL DEFAULT 'message_requests',
    connections             JSONB NOT NULL DEFAULT '[]',
    is_federated            BOOLEAN NOT NULL DEFAULT false,
    home_server             TEXT,
    remote_user_id          TEXT,
    signing_public_key      BYTEA,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT users_emoji_scale_check CHECK (emoji_scale >= 1.0 AND emoji_scale <= 5.0),
    CONSTRAINT chk_dm_privacy CHECK (dm_privacy IN ('anyone', 'message_requests', 'friends', 'mutual_servers', 'nobody')),
    CONSTRAINT chk_federated_columns CHECK (is_federated = false OR (home_server IS NOT NULL AND remote_user_id IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users (email) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_unique ON users (username) WHERE is_federated = false;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_federated_identity ON users (home_server, remote_user_id) WHERE is_federated = true;

-- Auth --

CREATE TABLE IF NOT EXISTS user_auth (
    user_id                       TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    auth_key_hash                 TEXT NOT NULL,
    salt                          BYTEA NOT NULL,
    encrypted_key_bundle          BYTEA NOT NULL,
    key_bundle_iv                 BYTEA NOT NULL,
    recovery_encrypted_key_bundle BYTEA,
    recovery_key_bundle_iv        BYTEA,
    recovery_verifier_hash        BYTEA,
    updated_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_recovery_bundle_pair CHECK (
        (recovery_encrypted_key_bundle IS NULL AND recovery_key_bundle_iv IS NULL)
        OR (recovery_encrypted_key_bundle IS NOT NULL AND recovery_key_bundle_iv IS NOT NULL)
    )
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
    token_hash TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id  TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user    ON refresh_tokens (user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires ON refresh_tokens (expires_at);

-- Servers --

CREATE TABLE IF NOT EXISTS servers (
    id                      TEXT PRIMARY KEY,
    name                    TEXT NOT NULL,
    icon_url                TEXT,
    owner_id                TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    welcome_message         TEXT DEFAULT NULL,
    rules                   TEXT DEFAULT NULL,
    onboarding_enabled      BOOLEAN NOT NULL DEFAULT false,
    rules_required          BOOLEAN NOT NULL DEFAULT false,
    default_channel_privacy BOOLEAN NOT NULL DEFAULT false,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS members (
    user_id                  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    server_id                TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    nickname                 TEXT,
    timed_out_until          TIMESTAMPTZ DEFAULT NULL,
    onboarding_completed_at  TIMESTAMPTZ DEFAULT NULL,
    rules_acknowledged_at    TIMESTAMPTZ DEFAULT NULL,
    joined_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, server_id)
);

CREATE INDEX IF NOT EXISTS idx_members_server ON members (server_id);
CREATE INDEX IF NOT EXISTS idx_members_user   ON members (user_id);

-- Channel groups --

CREATE TABLE IF NOT EXISTS channel_groups (
    id         TEXT PRIMARY KEY,
    server_id  TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    position   INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT channel_groups_name_length CHECK (length(name) >= 1 AND length(name) <= 100),
    CONSTRAINT channel_groups_position_check CHECK (position >= 0)
);

CREATE INDEX IF NOT EXISTS idx_channel_groups_server ON channel_groups (server_id, position);

-- Channels --

CREATE TABLE IF NOT EXISTS channels (
    id                    TEXT PRIMARY KEY,
    server_id             TEXT REFERENCES servers(id) ON DELETE CASCADE,
    channel_group_id      TEXT REFERENCES channel_groups(id) ON DELETE SET NULL,
    name                  TEXT NOT NULL,
    type                  SMALLINT NOT NULL DEFAULT 1,
    topic                 TEXT DEFAULT '',
    position              INTEGER NOT NULL DEFAULT 0,
    is_private            BOOLEAN NOT NULL DEFAULT false,
    is_default            BOOLEAN NOT NULL DEFAULT false,
    slow_mode_seconds     INT DEFAULT NULL,
    dm_pair_key           TEXT,
    dm_status             TEXT NOT NULL DEFAULT 'active',
    dm_initiator_id       TEXT DEFAULT NULL,
    voice_text_channel_id TEXT REFERENCES channels(id) ON DELETE SET NULL,
    content_warning       TEXT NOT NULL DEFAULT '',
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT channels_type_check CHECK (type IN (0, 1, 2, 3, 4)),
    CONSTRAINT chk_slow_mode CHECK (slow_mode_seconds IS NULL OR (slow_mode_seconds >= 0 AND slow_mode_seconds <= 21600)),
    CONSTRAINT chk_dm_status CHECK (dm_status IN ('active', 'pending', 'declined'))
);

CREATE UNIQUE INDEX IF NOT EXISTS channels_server_id_name_key ON channels (server_id, name) WHERE server_id IS NOT NULL AND voice_text_channel_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_dm_pair_key ON channels (dm_pair_key) WHERE dm_pair_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_channels_server ON channels (server_id, position);
CREATE INDEX IF NOT EXISTS idx_channels_group ON channels (channel_group_id);
CREATE INDEX IF NOT EXISTS idx_channels_dm_status ON channels (dm_status) WHERE type = 3 AND dm_status != 'active';
CREATE INDEX IF NOT EXISTS idx_channels_voice_text_channel_id ON channels (voice_text_channel_id) WHERE voice_text_channel_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS channel_members (
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    added_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (channel_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_channel_members_user ON channel_members (user_id);

-- Invites --

CREATE TABLE IF NOT EXISTS invites (
    code                   TEXT PRIMARY KEY,
    server_id              TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    creator_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    max_uses               INTEGER NOT NULL DEFAULT 0,
    use_count              INTEGER NOT NULL DEFAULT 0,
    expires_at             TIMESTAMPTZ,
    revoked                BOOLEAN NOT NULL DEFAULT false,
    encrypted_channel_keys BYTEA,
    channel_keys_iv        BYTEA,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT invites_max_uses_check  CHECK (max_uses  >= 0),
    CONSTRAINT invites_use_count_check CHECK (use_count >= 0)
);

CREATE INDEX IF NOT EXISTS idx_invites_server  ON invites (server_id);
CREATE INDEX IF NOT EXISTS idx_invites_creator ON invites (creator_id);

-- Attachments --

CREATE TABLE IF NOT EXISTS attachments (
    id                    TEXT PRIMARY KEY,
    uploader_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    upload_purpose        TEXT NOT NULL DEFAULT 'chat_attachment',
    object_key            TEXT NOT NULL UNIQUE,
    thumbnail_key         TEXT NOT NULL DEFAULT '',
    micro_thumbnail_data  TEXT NOT NULL DEFAULT '',
    filename              TEXT NOT NULL,
    content_type          TEXT NOT NULL DEFAULT 'application/octet-stream',
    size_bytes            BIGINT  NOT NULL DEFAULT 0,
    width                 INTEGER NOT NULL DEFAULT 0,
    height                INTEGER NOT NULL DEFAULT 0,
    status                TEXT NOT NULL DEFAULT 'pending',
    encrypted_key         BYTEA,
    original_content_type TEXT NOT NULL DEFAULT '',
    linked_at             TIMESTAMPTZ,
    channel_id            TEXT,
    is_spoiler            BOOLEAN NOT NULL DEFAULT false,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at          TIMESTAMPTZ,
    expires_at            TIMESTAMPTZ,
    CONSTRAINT attachments_status_check CHECK (status IN ('pending', 'processing', 'completed')),
    CONSTRAINT attachments_upload_purpose_check CHECK (upload_purpose IN (
        'chat_attachment', 'profile_avatar', 'profile_banner', 'server_icon', 'server_emoji', 'soundboard'
    ))
);

CREATE INDEX IF NOT EXISTS idx_attachments_uploader        ON attachments (uploader_id);
CREATE INDEX IF NOT EXISTS idx_attachments_uploader_pending ON attachments (uploader_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_attachments_cleanup          ON attachments (status, expires_at) WHERE status IN ('pending', 'processing');
CREATE INDEX IF NOT EXISTS idx_attachments_unlinked_cleanup ON attachments (completed_at) WHERE status = 'completed' AND linked_at IS NULL AND upload_purpose = 'chat_attachment';
CREATE INDEX IF NOT EXISTS idx_attachments_channel_id       ON attachments (channel_id) WHERE channel_id IS NOT NULL;

-- Roles --

CREATE TABLE IF NOT EXISTS roles (
    id               TEXT PRIMARY KEY,
    server_id        TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    name             TEXT NOT NULL,
    permissions      BIGINT  NOT NULL DEFAULT 0,
    color            INTEGER NOT NULL DEFAULT 0,
    position         INTEGER NOT NULL DEFAULT 0,
    is_self_assignable BOOLEAN NOT NULL DEFAULT false,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT roles_name_check     CHECK (length(name) >= 1 AND length(name) <= 100),
    CONSTRAINT roles_color_check    CHECK (color >= 0 AND color <= 16777215),
    CONSTRAINT roles_position_check CHECK (position >= 0),
    CONSTRAINT roles_server_position_unique UNIQUE (server_id, position) DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX IF NOT EXISTS idx_roles_server ON roles (server_id, position);

CREATE TABLE IF NOT EXISTS member_roles (
    user_id   TEXT NOT NULL,
    server_id TEXT NOT NULL,
    role_id   TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, server_id, role_id),
    FOREIGN KEY (user_id, server_id) REFERENCES members(user_id, server_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_member_roles_server_user ON member_roles (server_id, user_id);

-- Bans --

CREATE TABLE IF NOT EXISTS bans (
    server_id  TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    user_id    TEXT NOT NULL,
    reason     TEXT,
    banned_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (server_id, user_id),
    CONSTRAINT bans_reason_check CHECK (reason IS NULL OR (length(reason) >= 1 AND length(reason) <= 512))
);

-- Server emojis (with personal emoji support) --

CREATE TABLE IF NOT EXISTS server_emojis (
    id            TEXT PRIMARY KEY,
    server_id     TEXT REFERENCES servers(id) ON DELETE CASCADE,
    name          TEXT NOT NULL,
    attachment_id TEXT NOT NULL REFERENCES attachments(id) ON DELETE RESTRICT,
    animated      BOOLEAN NOT NULL DEFAULT false,
    creator_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_server_emojis_server_id ON server_emojis (server_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_emoji_user_name ON server_emojis (user_id, name) WHERE server_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_emoji_server_name ON server_emojis (server_id, name) WHERE server_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_server_emojis_attachment_id ON server_emojis (attachment_id);

-- Pinned messages --

CREATE TABLE IF NOT EXISTS pinned_messages (
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    message_id TEXT NOT NULL,
    pinned_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
    pinned_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (channel_id, message_id)
);

CREATE INDEX IF NOT EXISTS idx_pinned_messages_channel ON pinned_messages (channel_id, pinned_at DESC);

-- Audit log --

CREATE TABLE IF NOT EXISTS audit_log (
    id          TEXT PRIMARY KEY,
    server_id   TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    action      TEXT NOT NULL,
    actor_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    target_id   TEXT,
    target_type TEXT,
    metadata    JSONB,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_server_created ON audit_log (server_id, created_at DESC);

-- Soundboard --

CREATE TABLE IF NOT EXISTS soundboard_sounds (
    id            TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    server_id     TEXT REFERENCES servers(id) ON DELETE CASCADE,
    name          TEXT NOT NULL,
    attachment_id TEXT NOT NULL REFERENCES attachments(id) ON DELETE RESTRICT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT soundboard_name_check CHECK (length(name) >= 2 AND length(name) <= 32)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_soundboard_user_name ON soundboard_sounds (user_id, name) WHERE server_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_soundboard_server_name ON soundboard_sounds (server_id, name) WHERE server_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_soundboard_sounds_attachment_id ON soundboard_sounds (attachment_id);

-- Message reactions --

CREATE TABLE IF NOT EXISTS message_reactions (
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    message_id TEXT NOT NULL,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji      TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (channel_id, message_id, user_id, emoji),
    CONSTRAINT message_reactions_emoji_length CHECK (length(emoji) >= 1 AND length(emoji) <= 100)
);

CREATE INDEX IF NOT EXISTS idx_message_reactions_message ON message_reactions (channel_id, message_id);
CREATE INDEX IF NOT EXISTS idx_message_reactions_group_agg ON message_reactions (channel_id, message_id, emoji, created_at);

-- Channel read states --

CREATE TABLE IF NOT EXISTS channel_read_states (
    user_id              TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel_id           TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    last_read_message_id TEXT NOT NULL,
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, channel_id)
);

CREATE INDEX IF NOT EXISTS idx_channel_read_states_channel ON channel_read_states (channel_id);

-- Link previews --

CREATE TABLE IF NOT EXISTS link_previews (
    url_hash     TEXT PRIMARY KEY,
    url          TEXT NOT NULL,
    title        TEXT NOT NULL DEFAULT '',
    description  TEXT NOT NULL DEFAULT '',
    site_name    TEXT NOT NULL DEFAULT '',
    image_key    TEXT NOT NULL DEFAULT '',
    image_width  INTEGER NOT NULL DEFAULT 0,
    image_height INTEGER NOT NULL DEFAULT 0,
    favicon_key  TEXT NOT NULL DEFAULT '',
    og_type      TEXT NOT NULL DEFAULT '',
    fetched_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at   TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '24 hours'
);

CREATE TABLE IF NOT EXISTS message_link_previews (
    channel_id  TEXT NOT NULL,
    message_id  TEXT NOT NULL,
    url_hash    TEXT NOT NULL REFERENCES link_previews(url_hash) ON DELETE CASCADE,
    position    INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (channel_id, message_id, url_hash)
);

CREATE INDEX IF NOT EXISTS idx_message_link_previews_message ON message_link_previews (channel_id, message_id);

-- Notification preferences --

CREATE TABLE IF NOT EXISTS notification_preferences (
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    scope_type TEXT NOT NULL CHECK (scope_type IN ('global', 'server', 'channel')),
    scope_id   TEXT NOT NULL DEFAULT '',
    level      TEXT NOT NULL CHECK (level IN ('all', 'mentions_only', 'nothing')) DEFAULT 'all',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, scope_type, scope_id)
);

-- Devices --

CREATE TABLE IF NOT EXISTS devices (
    id                TEXT PRIMARY KEY,
    user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_name       TEXT NOT NULL DEFAULT '',
    platform          TEXT NOT NULL CHECK (platform IN ('web', 'android', 'ios', 'electron')),
    push_endpoint     TEXT,
    push_p256dh       TEXT,
    push_auth         TEXT,
    push_token        TEXT,
    push_enabled      BOOLEAN NOT NULL DEFAULT false,
    device_public_key TEXT,
    device_signature  TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_devices_user_id ON devices(user_id);
CREATE INDEX IF NOT EXISTS idx_devices_push_enabled ON devices(user_id) WHERE push_enabled = true;
CREATE INDEX IF NOT EXISTS idx_devices_last_seen ON devices(last_seen_at);

-- E2EE Channel Key Envelopes --

CREATE TABLE IF NOT EXISTS channel_key_envelopes (
    channel_id   TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key_version  INTEGER NOT NULL CHECK (key_version > 0),
    envelope     BYTEA NOT NULL CHECK (octet_length(envelope) = 93),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (channel_id, user_id, key_version)
);

CREATE INDEX IF NOT EXISTS idx_channel_key_envelopes_user ON channel_key_envelopes(user_id);

CREATE TABLE IF NOT EXISTS channel_key_versions (
    channel_id       TEXT NOT NULL PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
    current_version  INTEGER NOT NULL DEFAULT 1,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Permission overrides --

CREATE TABLE IF NOT EXISTS permission_overrides (
    id               TEXT PRIMARY KEY,
    channel_group_id TEXT REFERENCES channel_groups(id) ON DELETE CASCADE,
    channel_id       TEXT REFERENCES channels(id) ON DELETE CASCADE,
    role_id          TEXT REFERENCES roles(id) ON DELETE CASCADE,
    user_id          TEXT REFERENCES users(id) ON DELETE CASCADE,
    allow            BIGINT NOT NULL DEFAULT 0,
    deny             BIGINT NOT NULL DEFAULT 0,
    CONSTRAINT permission_overrides_target_check
        CHECK ((channel_group_id IS NOT NULL AND channel_id IS NULL)
            OR (channel_group_id IS NULL AND channel_id IS NOT NULL)),
    CONSTRAINT permission_overrides_role_or_user_check
        CHECK ((role_id IS NOT NULL AND user_id IS NULL) OR (role_id IS NULL AND user_id IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS permission_overrides_unique_group_role ON permission_overrides (channel_group_id, role_id) WHERE channel_group_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS permission_overrides_unique_channel_role ON permission_overrides (channel_id, role_id) WHERE channel_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_permission_overrides_role ON permission_overrides (role_id);
CREATE UNIQUE INDEX IF NOT EXISTS permission_overrides_unique_group_user ON permission_overrides (channel_group_id, user_id) WHERE channel_group_id IS NOT NULL AND user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS permission_overrides_unique_channel_user ON permission_overrides (channel_id, user_id) WHERE channel_id IS NOT NULL AND user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_permission_overrides_user ON permission_overrides (user_id);

-- User blocks --

CREATE TABLE IF NOT EXISTS user_blocks (
    blocker_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    blocked_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (blocker_id, blocked_id)
);

CREATE INDEX IF NOT EXISTS idx_user_blocks_blocked ON user_blocks (blocked_id, blocker_id);

-- Friendships --

CREATE TABLE IF NOT EXISTS friendships (
    requester_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    addressee_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted')),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    accepted_at  TIMESTAMPTZ,
    PRIMARY KEY (requester_id, addressee_id),
    CHECK (requester_id <> addressee_id)
);

CREATE INDEX IF NOT EXISTS idx_friendships_addressee_status ON friendships (addressee_id, status);
CREATE INDEX IF NOT EXISTS idx_friendships_accepted ON friendships (addressee_id, requester_id) WHERE status = 'accepted';

-- Server system message config --

CREATE TABLE IF NOT EXISTS server_system_message_config (
    server_id          TEXT PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
    welcome_channel_id TEXT REFERENCES channels(id) ON DELETE SET NULL,
    mod_log_channel_id TEXT REFERENCES channels(id) ON DELETE SET NULL,
    join_enabled       BOOLEAN NOT NULL DEFAULT true,
    join_template      TEXT,
    leave_enabled      BOOLEAN NOT NULL DEFAULT true,
    leave_template     TEXT,
    kick_enabled       BOOLEAN NOT NULL DEFAULT true,
    kick_template      TEXT,
    ban_enabled        BOOLEAN NOT NULL DEFAULT true,
    ban_template       TEXT,
    timeout_enabled    BOOLEAN NOT NULL DEFAULT true,
    timeout_template   TEXT,
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================================
-- Seed data
-- ============================================================================

INSERT INTO users (id, username, display_name, email, created_at, updated_at)
VALUES ('00000000000000000000000000', 'system', 'System', 'system@meza.local', now(), now())
ON CONFLICT DO NOTHING;
