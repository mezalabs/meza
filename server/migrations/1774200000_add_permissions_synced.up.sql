ALTER TABLE channels
    ADD COLUMN permissions_synced BOOLEAN NOT NULL DEFAULT false;

-- Channels that belong to a category default to synced.
UPDATE channels SET permissions_synced = true WHERE channel_group_id IS NOT NULL;

ALTER TABLE channels
    ADD CONSTRAINT chk_permissions_synced_requires_group
    CHECK (permissions_synced = false OR channel_group_id IS NOT NULL);
