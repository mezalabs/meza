-- Add voice_text_channel_id to link voice channels to their companion text channel.
ALTER TABLE channels ADD COLUMN voice_text_channel_id TEXT REFERENCES channels(id) ON DELETE SET NULL;

-- Drop the old unique index and recreate it excluding companion text channels
-- (they share the same name as the parent voice channel).
DROP INDEX IF EXISTS channels_server_id_name_key;
CREATE UNIQUE INDEX channels_server_id_name_key
  ON channels (server_id, name)
  WHERE server_id IS NOT NULL AND voice_text_channel_id IS NULL;

-- Index for quickly looking up which voice channel owns a companion.
CREATE INDEX idx_channels_voice_text_channel_id ON channels (voice_text_channel_id) WHERE voice_text_channel_id IS NOT NULL;
