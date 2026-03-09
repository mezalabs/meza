ALTER TABLE attachments ADD COLUMN IF NOT EXISTS linked_at TIMESTAMPTZ;

-- Index for cleanup: find completed chat attachments never linked to a message.
CREATE INDEX IF NOT EXISTS idx_attachments_unlinked_cleanup
    ON attachments (completed_at)
    WHERE status = 'completed' AND linked_at IS NULL AND upload_purpose = 'chat_attachment';
