ALTER TABLE attachments ADD COLUMN channel_id TEXT;

-- Index for access checks: look up a chat attachment's channel quickly.
CREATE INDEX IF NOT EXISTS idx_attachments_channel_id
    ON attachments (channel_id)
    WHERE channel_id IS NOT NULL;
