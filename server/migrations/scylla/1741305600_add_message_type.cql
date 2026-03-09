-- Add message_type column for system messages.
-- Existing rows default to null, which gocql maps to 0 (MESSAGE_TYPE_DEFAULT).
ALTER TABLE meza.messages ADD message_type int;
