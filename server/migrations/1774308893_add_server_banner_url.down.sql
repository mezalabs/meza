BEGIN;

-- Rollback: add_server_banner_url

ALTER TABLE servers DROP COLUMN IF EXISTS banner_url;

COMMIT;
