ALTER TABLE channels
    DROP CONSTRAINT IF EXISTS chk_permissions_synced_requires_group;

ALTER TABLE channels
    DROP COLUMN IF EXISTS permissions_synced;
