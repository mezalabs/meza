# Database Schema and Storage Strategy

## Overview

Meza uses three data stores, each chosen for a specific access pattern:

| Store | Purpose | Why |
|-------|---------|-----|
| PostgreSQL | Users, servers, channels, roles, members, auth | Relational integrity, complex joins, ACID transactions |
| ScyllaDB | Messages, message history | High write throughput, time-series partitioning, horizontal scaling |
| Redis | Presence, push notification tracking, ephemeral state | In-memory speed, TTL support, pub/sub |

---

## PostgreSQL Tables

The canonical schema lives in `server/migrations/`. Key tables:

| Table | Purpose |
|-------|---------|
| `users` | User accounts (email, username, display name, avatar, federation fields) |
| `user_auth` | Argon2id auth hash, salt, encrypted key bundle, signing public key, recovery bundle |
| `devices` | Per-device records with push notification credentials |
| `refresh_tokens` | SHA-256 hashed refresh tokens with expiry |
| `servers` | Guilds/servers (name, icon, owner, onboarding settings) |
| `channels` | Text, voice, DM, and group DM channels (with `dm_pair_key` deduplication) |
| `members` | Server membership (user + server + nickname) |
| `roles` | Server roles with permission bitfield and color |
| `member_roles` | Many-to-many: members to roles |
| `permission_overrides` | Per-channel or per-channel-group role permission overrides (allow/deny bitfields) |
| `channel_members` | Membership tracking for DM and private channels |
| `invites` | Server invite codes with max uses, expiry, revocation |
| `bans` | Server bans with reason |
| `channel_read_states` | Per-user last-read message tracking |
| `message_reactions` | Reactions per message per user |
| `pinned_messages` | Pinned messages per channel |
| `attachments` | File upload metadata (S3 keys, thumbnails, dimensions) |
| `channel_groups` | Collapsible channel categories |
| `channel_key_envelopes` | ECIES-wrapped E2EE channel keys per user per version |
| `channel_key_versions` | Current key version per channel |
| `link_previews` | Cached OpenGraph link preview data |
| `server_emojis` | Custom emoji per server |
| `soundboard_sounds` | Personal and server sound effects |
| `audit_log` | Server moderation audit trail |
| `user_blocks` | User block list |
| `friendships` | Friend requests and accepted friendships |
| `notification_preferences` | Per-scope (global/server/channel) notification levels |

---

## ScyllaDB Schema

ScyllaDB (Cassandra-compatible) is used for messages due to its high write throughput
and natural time-series partitioning.

### Messages Table Design

- **Partition key**: `channel_id` — all messages for a channel are co-located
- **Clustering key**: `message_id` (ULID, time-ordered), `DESC` ordering
- `DESC` ordering makes "fetch latest N messages" a single sequential read
- `TimeWindowCompactionStrategy` is optimal for time-series append-only data
- Soft deletes via `deleted` boolean (content nulled)
- `reply_to_id` column for reply threading
- A separate `message_replies` table enables efficient "get all replies to message X" queries by partitioning on `(channel_id, reply_to_id)`

### Query Patterns

- Fetch latest messages: `WHERE channel_id = ? LIMIT 50`
- Cursor pagination: `WHERE channel_id = ? AND message_id < ? LIMIT 50`
- Always query by partition key. Never do full table scans.
- Use `LIMIT` on all queries.
- Avoid `IN` queries on partition keys (scatter to multiple nodes).
- Use prepared statements (driver caches routing metadata).

### Partition Size Management

For extremely active channels, consider time-bucketed partitions (`(channel_id, bucket)`) if channels exceed ~100MB per partition. For most channels, the simple single-partition design is sufficient.

---

## Redis Data Structures

### Presence

```
Key:    presence:{user_id}
Type:   Hash
Fields: status (online|idle|dnd), status_text, last_seen
TTL:    60 seconds (renewed by heartbeat)
```

### Connected Devices (Push Notifications)

```
Key:    connected_devices:{user_id}
Type:   Set
Members: device_id values for devices with active gateway connections
TTL:    None (managed by gateway connect/disconnect)
```

Used to skip push notifications for devices with active connections.

### Notes

- **Rate limiting** uses in-memory token buckets per service process, not Redis.
- **Typing indicators** are broadcast via NATS, not stored in Redis.
- **Cross-node pub/sub** (e.g., force disconnect on new login) uses Redis Pub/Sub.

---

## Migration Strategy

Uses `golang-migrate` for PostgreSQL schema migrations with **timestamp-based naming** to prevent conflicts across concurrent worktrees.

```bash
# Create a new migration
task migrate:create -- add_user_profiles

# Run all pending migrations (PostgreSQL + ScyllaDB)
task migrate

# Reset if dirty
task teardown && task up && task migrate
```

Migration names must be lowercase snake_case. The timestamp prefix uses Unix epoch seconds.

---

## Backup Strategy

| Store | Method | Frequency | Retention |
|-------|--------|-----------|-----------|
| PostgreSQL | `pg_dump` + WAL archiving | Continuous WAL, daily full | 30 days |
| ScyllaDB | Snapshots + incremental | Daily snapshot | 14 days |
| Redis | RDB snapshots | Every 5 minutes | 7 days |
| S3 (files) | Cross-region replication | Real-time | Indefinite |
