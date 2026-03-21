BEGIN;

ALTER TABLE users
  ADD COLUMN friend_request_privacy TEXT NOT NULL DEFAULT 'everyone'
    CONSTRAINT chk_friend_request_privacy CHECK (friend_request_privacy IN ('everyone', 'server_co_members', 'nobody')),
  ADD COLUMN profile_privacy TEXT NOT NULL DEFAULT 'everyone'
    CONSTRAINT chk_profile_privacy CHECK (profile_privacy IN ('everyone', 'server_co_members', 'friends', 'nobody'));

COMMIT;
