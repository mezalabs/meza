-- Delete companion text channels (referenced BY voice channels via voice_text_channel_id).
DELETE FROM channels WHERE id IN (SELECT voice_text_channel_id FROM channels WHERE voice_text_channel_id IS NOT NULL);

-- Now clear the FK column and delete the voice channels that had companions.
UPDATE channels SET voice_text_channel_id = NULL;

-- Drop the new indexes and column.
DROP INDEX IF EXISTS idx_channels_voice_text_channel_id;
DROP INDEX IF EXISTS channels_server_id_name_key;

ALTER TABLE channels DROP COLUMN voice_text_channel_id;

-- Restore the original unique index.
CREATE UNIQUE INDEX channels_server_id_name_key ON channels (server_id, name) WHERE server_id IS NOT NULL;
