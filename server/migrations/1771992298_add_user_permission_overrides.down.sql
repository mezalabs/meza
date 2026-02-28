-- Remove user-based overrides before dropping column.
DELETE FROM permission_overrides WHERE user_id IS NOT NULL;

DROP INDEX IF EXISTS idx_permission_overrides_user;
DROP INDEX IF EXISTS permission_overrides_unique_channel_user;
DROP INDEX IF EXISTS permission_overrides_unique_group_user;

ALTER TABLE permission_overrides DROP CONSTRAINT IF EXISTS permission_overrides_role_or_user_check;
ALTER TABLE permission_overrides ALTER COLUMN role_id SET NOT NULL;
ALTER TABLE permission_overrides DROP COLUMN IF EXISTS user_id;
