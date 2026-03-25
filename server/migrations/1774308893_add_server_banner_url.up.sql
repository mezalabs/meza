BEGIN;

-- Migration: add_server_banner_url
-- All statements must be idempotent (use IF NOT EXISTS, IF EXISTS, ON CONFLICT, etc.)

ALTER TABLE servers ADD COLUMN IF NOT EXISTS banner_url TEXT;

-- Allow 'server_banner' as an upload purpose for attachments
ALTER TABLE attachments DROP CONSTRAINT IF EXISTS attachments_upload_purpose_check;
ALTER TABLE attachments ADD CONSTRAINT attachments_upload_purpose_check CHECK (upload_purpose IN (
    'chat_attachment', 'profile_avatar', 'profile_banner', 'server_icon', 'server_emoji', 'soundboard', 'server_banner'
));

COMMIT;
