ALTER TABLE invites
  ADD COLUMN encrypted_channel_keys BYTEA,
  ADD COLUMN channel_keys_iv BYTEA;
