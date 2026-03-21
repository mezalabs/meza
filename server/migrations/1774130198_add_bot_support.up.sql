BEGIN;

-- Bot flag and ownership on users table
ALTER TABLE users ADD COLUMN is_bot BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN bot_owner_id TEXT REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX idx_users_bot_owner ON users(bot_owner_id) WHERE bot_owner_id IS NOT NULL;

-- Enforce consistency: bots must have an owner, non-bots must not.
-- Note: bot_owner_id can become NULL via ON DELETE SET NULL when the owner is deleted.
ALTER TABLE users ADD CONSTRAINT chk_bot_owner_consistency
  CHECK ((is_bot = false AND bot_owner_id IS NULL) OR (is_bot = true));

-- Bot API tokens (opaque, SHA-256 hashed)
CREATE TABLE bot_tokens (
    id TEXT PRIMARY KEY,
    bot_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash BYTEA NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at TIMESTAMPTZ,
    revoked BOOLEAN NOT NULL DEFAULT false,
    UNIQUE(token_hash)
);
CREATE INDEX idx_bot_tokens_bot_user ON bot_tokens(bot_user_id);
CREATE INDEX idx_bot_tokens_hash ON bot_tokens(token_hash) WHERE revoked = false;

-- Outgoing webhooks
CREATE TABLE bot_webhooks (
    id TEXT PRIMARY KEY,
    bot_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    url TEXT NOT NULL CHECK (length(url) > 0),
    secret BYTEA NOT NULL CHECK (octet_length(secret) BETWEEN 32 AND 64),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(bot_user_id, server_id)
);
CREATE INDEX idx_bot_webhooks_server ON bot_webhooks(server_id);

COMMIT;
