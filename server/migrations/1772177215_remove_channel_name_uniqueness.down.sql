CREATE UNIQUE INDEX IF NOT EXISTS channels_server_id_name_key ON channels (server_id, name) WHERE server_id IS NOT NULL;
