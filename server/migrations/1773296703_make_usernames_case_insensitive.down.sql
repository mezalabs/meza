BEGIN;

-- Rollback: make_usernames_case_insensitive
-- Remove the CHECK constraint. Index stays the same (plain column index).
-- Note: Cannot restore original casing of usernames.

ALTER TABLE users DROP CONSTRAINT IF EXISTS chk_username_lowercase;

COMMIT;
