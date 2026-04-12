# Meza Architecture Overview

## Project Summary

Meza is an open-source, real-time chat platform designed for simplicity and performance.
It supports text messaging, voice, and video — with end-to-end encryption by default.

### Design Principles

1. **Dead simple to use** — No key management prompts, no recovery phrases. Users sign up and chat.
2. **Lean infrastructure** — Minimal services, maximum throughput per node.
3. **E2EE by default** — Server never sees plaintext messages. Liability is minimized.
4. **Portable** — Runs in browser, Electron desktop, and mobile (iOS/Android via Capacitor).
5. **Third-party friendly** — ConnectRPC with auto-generated client libraries.

---

## Technology Stack

| Layer | Technology | Version Target | Rationale |
|-------|-----------|----------------|-----------|
| Server language | Go | 1.25+ | Goroutine-per-connection model, low memory, fast compilation |
| Client language | TypeScript | 5.x | Type safety, broad ecosystem |
| Client framework | React | 19+ | Component model, hooks, concurrent rendering |
| Desktop shell | Electron | 34+ | Cross-platform desktop (Windows, macOS, Linux) |
| API protocol | ConnectRPC | v1 | gRPC + gRPC-Web + HTTP/1.1 in one protocol. Generates idiomatic TS/Go clients from Protobuf |
| Real-time transport | WebSockets | RFC 6455 | Browser-native, full-duplex, low latency |
| Message bus | NATS | 2.10+ | Sub-millisecond pub/sub, built for Go, supports JetStream persistence |
| Voice/Video | LiveKit | 1.x | Open-source Go SFU, Apache 2.0, WebRTC-based |
| Primary database | PostgreSQL | 16+ | Relational data: users, servers, channels, roles, permissions |
| Message store | ScyllaDB | 6.x | High write throughput, horizontal scaling, CQL compatible |
| Cache/Presence | Redis | 7+ | In-memory presence tracking, session state, cross-node pub/sub |
| Object storage | S3-compatible | MinIO or AWS S3 | File uploads, avatars, attachments |

---

## Service Architecture

```
                        ┌─────────────┐
                        │   Clients   │
                        │  (Browser,  │
                        │  Electron)  │
                        └──────┬──────┘
                               │
                    HTTPS / WSS / ConnectRPC
                               │
                        ┌──────▼──────┐
                        │   Reverse   │
                        │   Proxy     │
                        │  (Caddy)    │
                        └──────┬──────┘
                               │
              ┌────────────────┼────────────────┐
              │                │                │
       ┌──────▼──────┐ ┌──────▼──────┐ ┌───────▼──────┐
       │   Gateway    │ │   Gateway   │ │   Gateway    │
       │  (Shard 0)   │ │  (Shard 1)  │ │  (Shard N)   │
       │  WebSocket   │ │  WebSocket  │ │  WebSocket   │
       └──────┬──────┘ └──────┬──────┘ └──────┬───────┘
              │                │                │
              └────────────────┼────────────────┘
                               │
                        ┌──────▼──────┐
                        │    NATS     │
                        │  (Cluster)  │
                        └──────┬──────┘
                               │
         ┌──────────┬──────────┼──────────┬──────────┬──────────┐
         │          │          │          │          │          │
   ┌─────▼────┐┌───▼────┐┌────▼─────┐┌────▼─────┐┌────▼────┐┌─────▼──────┐
   │   Chat   ││Presence││  Media   ││  Voice   ││  Auth   ││Notification││  Keys   │
   │ Service  ││Service ││ Service  ││ Service  ││ Service ││  Service   ││ Service │
   └─────┬────┘└───┬────┘└────┬─────┘└────┬─────┘└────┬────┘└─────┬──────┘└────┬────┘
         │         │          │           │           │            │            │
    ┌────▼───┐┌────▼──┐ ┌────▼─────┐┌────▼─────┐┌────▼───┐  ┌────▼───┐   ┌────▼───┐
    │ScyllaDB││ Redis │ │   S3 /   ││ LiveKit  ││Postgres│  │Postgres│   │Postgres│
    │        ││       │ │  MinIO   ││  (SFU)   ││        │  │        │   │        │
    └────────┘└───────┘ └──────────┘└──────────┘└────────┘  └────────┘   └────────┘
```

---

## Service Responsibilities

### Gateway Service
- Accepts WebSocket connections from clients
- Authenticates connections via JWT
- Shards connections: each gateway instance handles a configurable number of connections (target: ~5,000 per shard)
- Subscribes to NATS subjects for channels/DMs the connected user belongs to
- Forwards inbound client messages to the appropriate NATS subject
- Delivers NATS messages to connected clients
- Manages heartbeat/keepalive
- Per-IP rate limiting

### Auth Service
- User registration and login
- Password hashing (Argon2id) for authentication
- JWT issuance and validation (HMAC-SHA256 and Ed25519 dual mode)
- Federation assertion token generation (audience-scoped, 60s TTL)
- OAuth2 provider integration (future)
- Stores auth data in PostgreSQL
- Profile updates (display name, avatar)

### Chat Service
- Message creation, editing, deletion, bulk deletion
- Channel and server (guild) management
- Channel groups (collapsible channel categories)
- Role and permission management, permission overrides (per-channel/group)
- Direct messages (create or get DM channel, list DMs, message requests accept/decline)
- Reactions (add, remove, get per message)
- Pins (pin, unpin, list pinned messages)
- Custom emojis (CRUD per server)
- Soundboard (CRUD for personal and server sounds)
- Moderation (kick, ban, unban, timeout, list bans, audit log)
- User reporting (in-app content reports for Google Play UGC compliance — see [`server/cmd/chat/service_reports.go`](../server/cmd/chat/service_reports.go) and [`docs/RUNBOOK_REPORTS.md`](RUNBOOK_REPORTS.md))
- Read state tracking (ack messages, get read states)
- Reply threading (get replies to a message)
- Channel members (add, remove, list per channel)
- Friends and blocks (send/accept/decline requests, block/unblock users)
- Server onboarding (rules acknowledgment, onboarding completion)
- Message metadata search (direct ScyllaDB queries, channel-scoped: author, date, attachments, mentions)
- Link preview embedding (via NATS embed worker)
- Server templates (create server from template)
- Persists messages to ScyllaDB
- Persists server/channel/role metadata to PostgreSQL
- Publishes events to NATS
- Invite management (create, resolve, revoke, list invites)

### Presence Service
- Tracks online/offline/idle/DND status
- Uses Redis with TTL-based heartbeat
- Publishes presence change events to NATS
- Handles typing indicators (ephemeral, not persisted)

### Media Service
- Handles file upload/download via S3-compatible storage (MinIO in dev)
- Generates thumbnails and micro-thumbnails for images (via libvips/govips)
- Supports multiple upload purposes: chat attachments, profile avatars/banners, server icons, emojis, soundboard
- Serves pre-signed URLs for uploads and downloads
- Tracks upload status and metadata in PostgreSQL

### Voice Service
- Manages LiveKit rooms (create on join, auto-destroy on empty)
- Issues LiveKit access tokens with permission-based grants
- Handles room creation/destruction lifecycle via LiveKit webhooks
- Routes voice channel join/leave events through NATS
- Screen share support via LiveKit track publishing

### Keys Service
- Manages E2EE public keys and channel key envelopes
- Stores Ed25519 signing public keys (registered at login/registration)
- Stores ECIES-wrapped channel key envelopes per member
- Supports key rotation with optimistic concurrency
- Replaces the earlier MLS service
- See [ENCRYPTION.md](./ENCRYPTION.md) for the full E2EE design

### Notification Service
- Push notifications via Web Push (VAPID)
- Per-user, per-server, and per-channel notification preferences (all, mentions only, nothing)
- Device registration with push subscription endpoints
- Subscribes to NATS delivery and device connectivity events
- Stores preferences and device push info in PostgreSQL

---

## Data Flow: Sending a Message

```
1. Client encrypts message with static channel key (AES-256-GCM, sign-then-encrypt)
2. Client sends encrypted payload over WebSocket to Gateway
3. Gateway forwards to Chat Service via ConnectRPC (SendMessage)
4. Chat Service validates permissions, persists encrypted message to ScyllaDB
5. Chat Service publishes delivery event to NATS: meza.deliver.channel.{channel_id}
6. All Gateway instances subscribed to that channel receive the event
7. Each Gateway pushes the encrypted message to relevant connected clients
8. Client decrypts with channel key and verifies Ed25519 signature
9. Client renders plaintext in UI
```

---

## NATS Subject Hierarchy

```
meza.
├── deliver.
│   └── channel.{channel_id}       # Message/event delivery to gateway (fan-out)
├── presence.
│   ├── heartbeat.{user_id}        # Keepalive pings from gateway
│   └── update.{user_id}           # Status change broadcasts
├── server.
│   ├── member.{server_id}         # Member join/leave/update/kick/ban
│   ├── channel.{server_id}        # Channel create/update/delete (with privacy prefix byte)
│   ├── role.{server_id}           # Role create/update/delete
│   ├── emoji.{server_id}          # Custom emoji events
│   ├── soundboard.{server_id}     # Soundboard sound events
│   └── channelgroup.{server_id}   # Channel group events
├── user.
│   ├── readstate.{user_id}        # Read state acknowledgments
│   └── subscription.{user_id}     # Per-user routing refresh signals + direct events (block/friend/DM)
├── device.
│   ├── connected.{user_id}        # WebSocket connect (gateway → notification service)
│   └── disconnected.{user_id}     # WebSocket disconnect
├── notify.
│   ├── message.new                # New message push (reserved for JetStream pipeline)
│   ├── mention                    # @mention push
│   └── dm                         # DM push
└── embed.
    └── fetch                      # Link preview fetch requests (chat → embed worker)
```

---

## Sharding Strategy

### Gateway Sharding
- Each gateway instance is a shard identified by `shard_id`
- Client connects to a shard assigned via consistent hashing of `user_id`
- Load balancer routes based on shard assignment header
- If a shard goes down, clients reconnect and are re-assigned

### ScyllaDB Partitioning
- Messages partitioned by `channel_id`
- Clustering key: `message_id` (Snowflake/ULID — time-ordered)
- Each partition holds one channel's messages, naturally ordered

### NATS Distribution
- NATS queue groups ensure each message is processed by exactly one Chat Service instance
- Gateway instances use regular subscriptions (fan-out) so all receive delivery events

---

## ID Generation

Use ULIDs (Universally Unique Lexicographically Sortable Identifiers):
- 128-bit, compatible with UUID storage
- Time-ordered (first 48 bits = millisecond timestamp)
- No coordination required between services
- Sortable as strings — useful for cursor-based pagination
- Go library: `github.com/oklog/ulid/v2`
- TypeScript library: `ulid`

---

## Authentication Flow

```
┌────────┐                    ┌──────────┐                    ┌──────────┐
│ Client │                    │   Auth   │                    │ Postgres │
│        │                    │ Service  │                    │          │
└───┬────┘                    └────┬─────┘                    └────┬─────┘
    │  POST /auth.v1.AuthService/ │                               │
    │  Register { email, pass }   │                               │
    │────────────────────────────►│                               │
    │                             │  Argon2id(pass) → auth_hash   │
    │                             │  Store user + hash            │
    │                             │──────────────────────────────►│
    │                             │                               │
    │                             │  Generate JWT (access+refresh)│
    │    { access_token,          │                               │
    │      refresh_token }        │                               │
    │◄────────────────────────────│                               │
    │                             │                               │
    │  WS /gateway?token={jwt}    │                               │
    │────────────────────────────►│  Validate JWT                 │
    │    Connection established   │                               │
    │◄────────────────────────────│                               │
```

### JWT Token Types

**HMAC-SHA256 Access Token** (legacy, single-instance):
```json
{
  "sub": "01HQXYZ...",        // user ULID
  "device_id": "01HQABC...", // device ULID
  "jti": "random-id",        // unique token ID
  "iat": 1700000000,
  "exp": 1700003600           // 1 hour TTL
}
```

**Ed25519 Access Token** (federation-ready):
```json
{
  "sub": "01HQXYZ...",        // user ULID
  "device_id": "01HQABC...", // device ULID
  "iss": "https://home.example.com", // issuer URL
  "jti": "random-id",
  "iat": 1700000000,
  "exp": 1700003600,
  "is_federated": false       // true for federated users
}
// Header includes "kid" (key ID) and "alg": "EdDSA"
```

**Refresh Token** (both HMAC and Ed25519 variants):
```json
{
  "sub": "01HQXYZ...",
  "device_id": "01HQABC...",
  "typ": "refresh",           // marks as refresh token
  "jti": "random-id",
  "iat": 1700000000,
  "exp": 1702592000           // 30 day TTL
}
```

**Federation Assertion Token** (short-lived, audience-scoped):
```json
{
  "sub": "01HQXYZ...",
  "iss": "https://home.example.com",
  "aud": "https://remote.example.com",  // target instance
  "purpose": "federation",              // prevents use as access token
  "display_name": "Alice",
  "avatar_url": "https://...",
  "jti": "random-id",
  "exp": 1700000060                     // 60 second TTL
}
```

### JWT Validation

- **Dual validation (CVE-2016-5431 prevention):** When Ed25519 keys are configured, `ValidateTokenDual` performs two-pass verification — Ed25519 first (pinned to `EdDSA` via `jwt.WithValidMethods`), then HMAC fallback (pinned to `HS256`). Key material is never mixed between algorithms.
- **Federation assertion rejection:** `extractClaims` rejects any token with a `purpose` claim, ensuring federation assertion tokens cannot be used as access tokens.
- **Verification cache:** SHA-256 keyed cache (max 50k entries) avoids repeated Ed25519 verification (~35us/op) on the hot path.
- **Device blocklist:** Tokens for revoked devices are rejected via Redis-backed blocklist.

### Token Policies

- Access token: 1 hour TTL
- Refresh token: 30 day TTL, stored in HttpOnly cookie
- Refresh rotation: each refresh issues a new refresh token, old one invalidated
- Federation assertion: 60 second TTL, audience-scoped, single-use (JTI replay protection)

---

## Project Repository Structure

```
meza/
├── docs/                        # This documentation
├── proto/                       # Protobuf definitions (source of truth for API)
│   └── meza/v1/                 # All .proto files (auth, chat, gateway, etc.)
├── server/                      # Go monorepo for all backend services
│   ├── cmd/                     # Service entry points (one per service + migrate tool)
│   ├── internal/                # Shared internal packages (auth, config, database, etc.)
│   ├── migrations/              # PostgreSQL + ScyllaDB migrations
│   └── gen/                     # Generated ConnectRPC Go code (do not edit)
├── client/                      # TypeScript monorepo (pnpm workspaces)
│   ├── packages/
│   │   ├── core/                # Shared logic: state, API client, crypto, tiling
│   │   ├── ui/                  # React component library
│   │   ├── web/                 # Browser app (Vite)
│   │   ├── desktop/             # Electron shell
│   │   └── mobile/              # Capacitor native shell (iOS/Android)
│   └── gen/                     # Generated ConnectRPC TypeScript code (do not edit)
├── deploy/                      # Docker Compose, Caddy configs
└── Taskfile.yml                 # Development task runner
```

---

## Cross-Document References

| Topic | Document |
|-------|----------|
| Go server implementation details | [SERVER.md](./SERVER.md) |
| Client architecture and Electron setup | [CLIENT.md](./CLIENT.md) |
| E2EE key management and crypto | [ENCRYPTION.md](./ENCRYPTION.md) |
| API conventions and ConnectRPC | [API.md](./API.md) |
| Database schemas and queries | [DATABASE.md](./DATABASE.md) |
| Voice and video with LiveKit | [VOICEVIDEO.md](./VOICEVIDEO.md) |
| Infrastructure and scaling | [INFRASTRUCTURE.md](./INFRASTRUCTURE.md) |
