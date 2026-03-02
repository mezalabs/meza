ALTER TABLE servers
  DROP COLUMN IF EXISTS join_message_channel_id,
  DROP COLUMN IF EXISTS join_message_template,
  DROP COLUMN IF EXISTS join_message_enabled;
