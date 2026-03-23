BEGIN;

-- Migration: add_server_banner_url
-- All statements must be idempotent (use IF NOT EXISTS, IF EXISTS, ON CONFLICT, etc.)

ALTER TABLE servers ADD COLUMN IF NOT EXISTS banner_url TEXT;

COMMIT;
