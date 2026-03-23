-- Backfill is not reversible; setting all to true is the safe default.
UPDATE channels SET permissions_synced = true;
