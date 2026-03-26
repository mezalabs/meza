BEGIN;

-- Migration: dedup_accepted_friendships
-- Remove duplicate accepted friendships where both (A,B) and (B,A) exist as
-- accepted. Keep the row with the earlier accepted_at (or earlier created_at
-- as tiebreaker). Then add a unique partial index to prevent future duplicates.

DELETE FROM friendships f1
USING friendships f2
WHERE f1.requester_id = f2.addressee_id
  AND f1.addressee_id = f2.requester_id
  AND f1.status = 'accepted'
  AND f2.status = 'accepted'
  AND (
    f1.accepted_at > f2.accepted_at
    OR (f1.accepted_at = f2.accepted_at AND f1.requester_id > f1.addressee_id)
  );

-- Prevent two accepted rows between the same pair regardless of direction.
CREATE UNIQUE INDEX IF NOT EXISTS idx_friendships_unique_pair_accepted
ON friendships (LEAST(requester_id, addressee_id), GREATEST(requester_id, addressee_id))
WHERE status = 'accepted';

COMMIT;
