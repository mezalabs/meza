-- Compact any existing position gaps or duplicates per server
WITH ranked AS (
  SELECT id, server_id,
    ROW_NUMBER() OVER (PARTITION BY server_id ORDER BY position, created_at) - 1 AS new_pos
  FROM roles
)
UPDATE roles r SET position = ranked.new_pos
FROM ranked WHERE r.id = ranked.id AND r.position != ranked.new_pos;

-- Add deferred unique constraint on (server_id, position) if not already present
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'roles_server_position_unique'
  ) THEN
    ALTER TABLE roles ADD CONSTRAINT roles_server_position_unique
      UNIQUE (server_id, position) DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
