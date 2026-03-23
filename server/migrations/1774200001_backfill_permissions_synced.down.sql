-- Backfill is not reversible; reset to synced only where a category exists
-- (respects chk_permissions_synced_requires_group CHECK constraint).
UPDATE channels SET permissions_synced = true WHERE channel_group_id IS NOT NULL;
UPDATE channels SET permissions_synced = false WHERE channel_group_id IS NULL;
