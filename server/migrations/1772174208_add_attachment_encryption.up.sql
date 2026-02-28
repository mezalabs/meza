ALTER TABLE attachments
  ADD COLUMN IF NOT EXISTS encrypted_key BYTEA,
  ADD COLUMN IF NOT EXISTS original_content_type TEXT NOT NULL DEFAULT '';
