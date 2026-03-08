-- Configurable system message settings per server.
-- Two-bucket channel routing (welcome + mod log) with per-event enable/disable and custom templates.
CREATE TABLE server_system_message_config (
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
