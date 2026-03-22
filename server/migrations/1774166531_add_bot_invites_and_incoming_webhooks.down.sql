BEGIN;

DROP TABLE IF EXISTS incoming_webhooks;
DROP TABLE IF EXISTS bot_invites;
ALTER TABLE users DROP COLUMN IF EXISTS bot_description;

COMMIT;
