DROP INDEX IF EXISTS idx_soundboard_sounds_attachment_id;
DROP INDEX IF EXISTS idx_server_emojis_attachment_id;
DROP INDEX IF EXISTS idx_attachments_channel_id;
ALTER TABLE attachments DROP COLUMN IF EXISTS channel_id;
