-- Remove companion text channels first (they reference voice channels).
DELETE FROM channels WHERE voice_text_channel_id IS NOT NULL;

-- Drop the new indexes and column.
DROP INDEX IF EXISTS idx_channels_voice_text_channel_id;
DROP INDEX IF EXISTS channels_server_id_name_key;

ALTER TABLE channels DROP COLUMN voice_text_channel_id;

-- Restore the original unique index.
CREATE UNIQUE INDEX channels_server_id_name_key ON channels (server_id, name) WHERE server_id IS NOT NULL;
