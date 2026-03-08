CREATE TABLE federated_memberships (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  satellite_url TEXT NOT NULL CHECK (
    satellite_url ~ '^https://' AND length(satellite_url) <= 2048
  ),
  server_id TEXT NOT NULL,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, satellite_url, server_id)
);
