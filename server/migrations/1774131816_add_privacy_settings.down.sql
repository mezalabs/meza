BEGIN;

ALTER TABLE users
  DROP COLUMN friend_request_privacy,
  DROP COLUMN profile_privacy;

COMMIT;
