DROP INDEX IF EXISTS idx_attachments_unlinked_cleanup;
ALTER TABLE attachments DROP COLUMN IF EXISTS linked_at;
