-- Add user_id column (nullable — set for user overrides, NULL for role overrides).
DO $$ BEGIN
    ALTER TABLE permission_overrides ADD COLUMN user_id TEXT REFERENCES users(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

-- Make role_id nullable (was NOT NULL — role overrides still set it, user overrides don't).
ALTER TABLE permission_overrides ALTER COLUMN role_id DROP NOT NULL;

-- Enforce: exactly one of role_id or user_id must be set.
DO $$ BEGIN
    ALTER TABLE permission_overrides ADD CONSTRAINT permission_overrides_role_or_user_check
        CHECK ((role_id IS NOT NULL AND user_id IS NULL) OR (role_id IS NULL AND user_id IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Unique indexes for user overrides (mirror the existing role indexes).
CREATE UNIQUE INDEX IF NOT EXISTS permission_overrides_unique_group_user
    ON permission_overrides (channel_group_id, user_id) WHERE channel_group_id IS NOT NULL AND user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS permission_overrides_unique_channel_user
    ON permission_overrides (channel_id, user_id) WHERE channel_id IS NOT NULL AND user_id IS NOT NULL;

-- Lookup index for user overrides.
CREATE INDEX IF NOT EXISTS idx_permission_overrides_user ON permission_overrides (user_id);
