DROP INDEX IF EXISTS idx_attachments_channel_id;
ALTER TABLE attachments DROP COLUMN IF EXISTS channel_id;
