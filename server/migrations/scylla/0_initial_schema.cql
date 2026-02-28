-- WARNING: replication_factor = 1 is for development only.
-- For production, use NetworkTopologyStrategy with RF >= 3:
--   CREATE KEYSPACE IF NOT EXISTS meza
--   WITH replication = {'class': 'NetworkTopologyStrategy', 'dc1': 3};
-- Also change ConsistencyLevel from ONE to LOCAL_QUORUM in the Go client.

CREATE KEYSPACE IF NOT EXISTS meza WITH replication = {
    'class': 'SimpleStrategy',
    'replication_factor': 1
};

CREATE TABLE IF NOT EXISTS meza.messages (
    channel_id         TEXT,
    message_id         TEXT,
    author_id          TEXT,
    encrypted_content  BLOB,
    attachment_ids     LIST<TEXT>,
    reply_to_id        TEXT,
    mentioned_user_ids FROZEN<LIST<TEXT>>,
    mentioned_role_ids FROZEN<LIST<TEXT>>,
    mention_everyone   BOOLEAN,
    key_version        INT,
    created_at         TIMESTAMP,
    edited_at          TIMESTAMP,
    deleted            BOOLEAN,
    PRIMARY KEY (channel_id, message_id)
) WITH CLUSTERING ORDER BY (message_id DESC);

CREATE TABLE IF NOT EXISTS meza.message_replies (
    channel_id    TEXT,
    reply_to_id   TEXT,
    message_id    TEXT,
    author_id     TEXT,
    created_at    TIMESTAMP,
    PRIMARY KEY ((channel_id, reply_to_id), message_id)
) WITH CLUSTERING ORDER BY (message_id ASC);
