BEGIN;

-- Rollback: add_server_banner_url

ALTER TABLE servers DROP COLUMN IF EXISTS banner_url;

-- Restore original upload purpose constraint without 'server_banner'
ALTER TABLE attachments DROP CONSTRAINT IF EXISTS attachments_upload_purpose_check;
ALTER TABLE attachments ADD CONSTRAINT attachments_upload_purpose_check CHECK (upload_purpose IN (
    'chat_attachment', 'profile_avatar', 'profile_banner', 'server_icon', 'server_emoji', 'soundboard'
));

COMMIT;
