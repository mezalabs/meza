UPDATE channels
SET permissions_synced = false
WHERE id IN (
    SELECT DISTINCT channel_id
    FROM permission_overrides
    WHERE channel_id IS NOT NULL
);
