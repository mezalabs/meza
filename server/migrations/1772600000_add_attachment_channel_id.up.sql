ALTER TABLE attachments ADD COLUMN channel_id TEXT;

-- Index for access checks: look up a chat attachment's channel quickly.
CREATE INDEX IF NOT EXISTS idx_attachments_channel_id
    ON attachments (channel_id)
    WHERE channel_id IS NOT NULL;

-- Indexes for media access checks: look up emoji/soundboard by attachment_id.
CREATE INDEX IF NOT EXISTS idx_server_emojis_attachment_id
    ON server_emojis (attachment_id);
CREATE INDEX IF NOT EXISTS idx_soundboard_sounds_attachment_id
    ON soundboard_sounds (attachment_id);
