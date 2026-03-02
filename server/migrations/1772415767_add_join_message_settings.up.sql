ALTER TABLE servers
  ADD COLUMN join_message_enabled BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN join_message_template TEXT NOT NULL DEFAULT 'Welcome to {server_name}, {username}!',
  ADD COLUMN join_message_channel_id TEXT REFERENCES channels(id) ON DELETE SET NULL;
