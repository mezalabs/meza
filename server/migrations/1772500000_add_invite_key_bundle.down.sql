ALTER TABLE invites
  DROP COLUMN IF EXISTS encrypted_channel_keys,
  DROP COLUMN IF EXISTS channel_keys_iv;
