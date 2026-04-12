BEGIN;

-- Migration: create_reports_tables
-- All statements must be idempotent (use IF NOT EXISTS, IF EXISTS, ON CONFLICT, etc.)
--
-- In-app content reporting (Google Play UGC compliance, plan 2026-04-06).
-- Reports are user-action-before-the-fact (distinct from audit_log which is
-- mod-action-after-the-fact). Resolutions are append-only in a child table
-- so the audit trail survives reopen and merge.
--
-- ID type is TEXT (not ulid/uuid) — application-generated ULIDs match the
-- rest of the codebase (users.id, servers.id, channels.id).
--
-- The MANAGE_REPORTS permission bit (1 << 30, defined in permissions.go)
-- defaults OFF for everyone. Server owners explicitly grant via the roles
-- UI; we deliberately do not auto-backfill into MANAGE_MESSAGES roles to
-- avoid silently exposing reporter PII to community helpers.

CREATE TABLE IF NOT EXISTS reports (
    id                            TEXT PRIMARY KEY,
    reporter_id                   TEXT REFERENCES users(id) ON DELETE SET NULL,
    target_user_id                TEXT REFERENCES users(id) ON DELETE SET NULL,
    target_message_id             TEXT,                          -- ScyllaDB ULID, no FK
    target_channel_id             TEXT REFERENCES channels(id) ON DELETE SET NULL,
    server_id                     TEXT REFERENCES servers(id) ON DELETE SET NULL,
    snapshot_content              TEXT NOT NULL DEFAULT '',
    snapshot_author_username      TEXT NOT NULL DEFAULT '',
    snapshot_author_display_name  TEXT NOT NULL DEFAULT '',
    snapshot_attachments          JSONB NOT NULL DEFAULT '[]'::jsonb,
    snapshot_message_edited_at    TIMESTAMPTZ,
    snapshot_purged_at            TIMESTAMPTZ,                   -- reserved for future cleanup job
    category                      TEXT NOT NULL CHECK (category IN
        ('spam','harassment','hate','sexual','violence','self_harm','illegal','other')),
    reason                        TEXT,
    status                        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','dismissed')),
    claimed_by                    TEXT REFERENCES users(id) ON DELETE SET NULL,
    claimed_at                    TIMESTAMPTZ,
    acknowledged_at               TIMESTAMPTZ,
    idempotency_key               TEXT,
    created_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT reports_reason_check CHECK (reason IS NULL OR (length(reason) BETWEEN 1 AND 1000)),
    CONSTRAINT reports_snapshot_content_check CHECK (length(snapshot_content) <= 8000),
    CONSTRAINT reports_target_required CHECK (target_user_id IS NOT NULL OR target_message_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_reports_server_status_created
    ON reports (server_id, status, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_reports_reporter_created
    ON reports (reporter_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_reports_target_user
    ON reports (target_user_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_reports_open_per_message_unique
    ON reports (reporter_id, target_message_id)
    WHERE status = 'open' AND target_message_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_reports_idempotency_unique
    ON reports (reporter_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_reports_platform_status_created
    ON reports (status, created_at DESC, id DESC)
    WHERE server_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_reports_retention_cleanup
    ON reports (status, created_at)
    WHERE snapshot_purged_at IS NULL AND status IN ('resolved','dismissed');

CREATE TABLE IF NOT EXISTS report_resolutions (
    id            TEXT PRIMARY KEY,
    report_id     TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
    moderator_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
    action        TEXT NOT NULL CHECK (action IN ('resolved','dismissed','reopen')),
    note          TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT report_resolutions_note_check CHECK (note IS NULL OR (length(note) BETWEEN 1 AND 1000))
);

CREATE INDEX IF NOT EXISTS idx_report_resolutions_report
    ON report_resolutions (report_id, created_at);

COMMIT;
