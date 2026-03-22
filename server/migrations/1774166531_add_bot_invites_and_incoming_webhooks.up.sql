BEGIN;

-- Bot description on users table
ALTER TABLE users ADD COLUMN bot_description TEXT;

-- Bot invite links
CREATE TABLE bot_invites (
    code TEXT PRIMARY KEY,
    bot_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    requested_permissions BIGINT NOT NULL DEFAULT 0,
    creator_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + INTERVAL '7 days'
);
CREATE INDEX idx_bot_invites_bot_id ON bot_invites(bot_id);

-- Incoming webhooks (channel-bound, separate from outgoing bot_webhooks)
CREATE TABLE incoming_webhooks (
    id TEXT PRIMARY KEY,
    bot_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    secret_hash BYTEA NOT NULL,
    creator_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(bot_user_id, channel_id)
);
CREATE INDEX idx_incoming_webhooks_server ON incoming_webhooks(server_id);
CREATE INDEX idx_incoming_webhooks_channel ON incoming_webhooks(channel_id);

COMMIT;
