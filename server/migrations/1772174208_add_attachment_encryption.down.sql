ALTER TABLE attachments
  DROP COLUMN IF EXISTS encrypted_key,
  DROP COLUMN IF EXISTS original_content_type;
