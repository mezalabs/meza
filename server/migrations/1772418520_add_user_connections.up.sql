ALTER TABLE users ADD COLUMN connections JSONB NOT NULL DEFAULT '[]'::jsonb;
