BEGIN;

-- Migration: make_usernames_case_insensitive
-- Normalize all non-federated usernames to lowercase and enforce the invariant.

-- Lock table to prevent concurrent writes during migration.
LOCK TABLE users IN EXCLUSIVE MODE;

-- Normalize existing usernames to lowercase (skip already-lowercase rows).
UPDATE users SET username = LOWER(username)
WHERE username != LOWER(username) AND is_federated = false;

-- Recreate the unique index (same plain column index — works because data is now lowercase).
DROP INDEX IF EXISTS idx_users_username_unique;
CREATE UNIQUE INDEX idx_users_username_unique ON users (username) WHERE is_federated = false;

-- Add CHECK constraint to enforce lowercase for non-federated users.
-- Federated users use shadowUsername() which generates uppercase ULID suffixes.
ALTER TABLE users ADD CONSTRAINT chk_username_lowercase CHECK (is_federated = true OR username = LOWER(username));

COMMIT;
