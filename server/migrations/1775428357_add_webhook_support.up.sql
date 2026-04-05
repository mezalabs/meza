-- Webhooks: external services that can POST messages to channels.
CREATE TABLE webhooks (
    id          TEXT PRIMARY KEY,
    channel_id  TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    server_id   TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    avatar_url  TEXT NOT NULL DEFAULT '',
    token_hash  BYTEA NOT NULL,
    created_by  TEXT NOT NULL REFERENCES users(id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_webhooks_channel_id ON webhooks(channel_id);
CREATE INDEX idx_webhooks_server_id ON webhooks(server_id);

-- Delivery logs for debugging webhook POST attempts.
CREATE TABLE webhook_deliveries (
    id                   TEXT PRIMARY KEY,
    webhook_id           TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
    success              BOOLEAN NOT NULL,
    error_code           TEXT NOT NULL DEFAULT '',
    request_body_preview TEXT NOT NULL DEFAULT '',
    message_id           TEXT NOT NULL DEFAULT '',
    source_ip            TEXT NOT NULL DEFAULT '',
    latency_ms           INT NOT NULL DEFAULT 0,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_webhook_deliveries_webhook_id ON webhook_deliveries(webhook_id);
