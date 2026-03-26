BEGIN;

-- Rollback: dedup_accepted_friendships
-- Drop the unique index. Duplicate rows cannot be restored.
DROP INDEX IF EXISTS idx_friendships_unique_pair_accepted;

COMMIT;
