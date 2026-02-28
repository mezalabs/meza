# Server Implementation Guide

## Overview

The Meza server is a set of Go services communicating over NATS. Each service is a
standalone binary in `server/cmd/`. Shared code lives in `server/internal/`.

All services expose health checks. The Gateway service additionally handles
WebSocket connections. All other services expose ConnectRPC endpoints: Auth, Chat, Presence, Media, Voice, Keys, and Notification.

---

## Go Module Layout

```
server/
├── cmd/                            # Service entry points
│   ├── gateway/                    # WebSocket gateway
│   ├── auth/                       # Auth service
│   ├── chat/                       # Chat service (messages, channels, servers, roles, DMs, moderation, etc.)
│   ├── presence/                   # Presence service
│   ├── media/                      # Media service (upload/download, thumbnails)
│   ├── voice/                      # Voice service (LiveKit integration)
│   ├── keys/                       # E2EE key envelope management
│   ├── notification/               # Push notification service
│   └── migrate/                    # Database migration tool
├── internal/                       # Shared internal packages
│   ├── auth/                       # JWT, Argon2id, ConnectRPC interceptor
│   ├── config/                     # Env-based configuration (envconfig)
│   ├── database/                   # PostgreSQL + ScyllaDB connection setup
│   ├── imaging/                    # Image processing (thumbnails via govips)
│   ├── models/                     # ULID generation helpers
│   ├── nats/                       # NATS connection + helpers
│   ├── observability/              # Structured logging (slog) + Prometheus metrics
│   ├── permissions/                # Permission checking logic
│   ├── ratelimit/                  # Per-IP rate limiting
│   ├── redis/                      # Redis client
│   ├── s3/                         # S3-compatible storage client
│   ├── store/                      # Data access layer (interfaces + implementations)
│   ├── subjects/                   # NATS subject helpers
│   ├── embed/                      # Link preview extraction (OpenGraph)
│   ├── federation/                 # Federation assertion verification
│   ├── middleware/                 # Security headers
│   ├── search/                     # Meilisearch integration
│   └── testutil/                   # Test helpers
├── migrations/                     # PostgreSQL + ScyllaDB migrations
└── gen/                            # Auto-generated from proto/ (do not edit)
```

---

## Key Dependencies

| Category | Library | Purpose |
|----------|---------|---------|
| API | `connectrpc.com/connect` | ConnectRPC server handlers |
| WebSocket | `github.com/coder/websocket` | Gateway WebSocket connections |
| PostgreSQL | `github.com/jackc/pgx/v5` | PostgreSQL driver + connection pool |
| ScyllaDB | `github.com/gocql/gocql` | ScyllaDB/Cassandra driver |
| Redis | `github.com/redis/go-redis/v9` | Redis client |
| NATS | `github.com/nats-io/nats.go` | NATS messaging |
| JWT | `github.com/golang-jwt/jwt/v5` | JWT creation/validation |
| Crypto | `golang.org/x/crypto` | Argon2id password hashing |
| IDs | `github.com/oklog/ulid/v2` | ULID generation |
| LiveKit | `github.com/livekit/server-sdk-go/v2` | LiveKit server SDK |
| Push | `github.com/SherClockHolmes/webpush-go` | Web Push (VAPID) |
| Imaging | `github.com/davidbyttow/govips/v2` | Image thumbnails (libvips) |
| Config | `github.com/kelseyhightower/envconfig` | Env-based config |
| Metrics | `github.com/prometheus/client_golang` | Prometheus metrics |

---

## Gateway Service

The gateway is the most performance-critical service. It holds all client WebSocket
connections and routes messages between clients and NATS.

### Connection Lifecycle

1. Client connects via WebSocket with JWT (query param or header)
2. JWT validated, WebSocket upgraded with `meza.v1` subprotocol
3. Client registered in memory (`user_id` → `Client`)
4. Gateway subscribes to all NATS subjects for the user's channels + user-specific events
5. Read pump and write pump goroutines started (standard Go WebSocket pattern)
6. Read pump: parses binary protobuf envelopes, publishes to appropriate NATS subject
7. Write pump: drains send channel to WebSocket, sends pings every 30s
8. On disconnect, client removed and NATS subscriptions unsubscribed

### Key Constants

- Max connections per shard: ~5,000
- Max message size: 64KB
- Write timeout: 10s
- Ping interval: 30s
- Send buffer: 256 messages

---

## Chat Service

The chat service processes messages: validates permissions, persists to ScyllaDB, and publishes delivery events to NATS. It also handles channels, servers, roles, invites, DMs, reactions, pins, emojis, soundboard, moderation, read state, friends, and blocks.

### Message Flow

1. Receive `SendMessage` RPC with encrypted content
2. Check `SendMessages` permission for user in channel
3. Generate ULID message ID
4. Persist encrypted message to ScyllaDB
5. Publish delivery event to `meza.deliver.channel.{channel_id}`
6. All gateway instances subscribed to that channel fan out to connected clients

The chat service also runs NATS queue group consumers for background processing (messages routed from gateway).

---

## Auth Service

- **Password hashing**: Argon2id (`t=3, m=64MB, p=4`) — hashes the auth key received from the client
- **JWT issuance**: HMAC-SHA256 (legacy) and Ed25519 (federation-ready) dual mode
- **ConnectRPC interceptor**: Validates JWT on all authenticated RPCs

### Auth Interceptor Options

The interceptor supports: user existence checks, Ed25519 dual validation (EdDSA first, HMAC fallback, CVE-2016-5431 prevention), verification caching (SHA-256 keyed, max 50k entries), federation user blocking, device blocklist (Redis-backed), and public procedure bypass.

### Validation Pipeline

1. Extract Bearer token from Authorization header
2. Check verification cache
3. Dual validation: Ed25519 (pinned EdDSA) → HMAC fallback (pinned HS256)
4. Reject refresh tokens and federation assertion tokens
5. Check device blocklist
6. Verify user existence (optional)
7. Block federated users (optional)
8. Inject `userID` + `deviceID` into context

---

## Presence Service

Uses Redis with TTL-based heartbeat:
- `HSET presence:{user_id}` with 60s TTL
- Heartbeat renews the TTL
- Bulk presence lookup pipelines multiple `HGET` commands
- Publishes presence changes to NATS for gateway fan-out

---

## Keys Service

Manages E2EE public keys and channel key envelopes (port 8088). See [ENCRYPTION.md](./ENCRYPTION.md).

- Register user Ed25519 signing public keys
- Store/retrieve ECIES-wrapped channel key envelopes
- Key rotation with optimistic concurrency control
- Rate limit: 20 req/s, burst 40

---

## Configuration

All services use environment variables via `envconfig` with `MEZA_` prefix. No config files in production. Key vars: `LISTEN_ADDR`, `NATS_URL`, `POSTGRES_URL`, `SCYLLA_HOSTS`, `REDIS_URL`, `HMAC_SECRET`, `S3_ENDPOINT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`.

---

## Observability

- **Logging**: Structured JSON via `slog` (configurable level via `MEZA_LOG_LEVEL`)
- **Metrics**: Prometheus counters (`meza_requests_total` by method/code) and histograms (`meza_request_duration_seconds` by method) on `/metrics`
- **Health checks**: All services expose `GET /health` checking critical dependencies

---

## Permission Resolution

Permission enforcement follows a 9-step resolution algorithm:

1. **Owner bypass** → all permissions granted
2. **Base** = @everyone role permissions | all assigned role permissions
3. **Administrator short-circuit** → all permissions granted
4. **Timeout strip** → timed-out members get only `ViewChannel | ReadMessageHistory`
5. **Category role overrides** — aggregated allow/deny
6. **Channel role overrides** — more specific than category
7. **Category user override** — per-user at category level
8. **Channel user override** — most specific, wins over everything
9. **ViewChannel denied** → returns 0

**Channel-scoped permissions** (overridable per-channel/category): ManageMessages, ManageEmojis, ManageSoundboard, AddReactions, ViewChannel, SendMessages, Connect, Speak, MentionEveryone, ExemptSlowMode, StreamVideo, EmbedLinks, AttachFiles, ReadMessageHistory, UseExternalEmojis, MuteMembers, DeafenMembers, MoveMembers.

**Server-only permissions** (NOT overridable): Administrator, ManageServer, ManageRoles, ManageChannels, KickMembers, BanMembers, TimeoutMembers, ManageNicknames, ViewAuditLog, ChangeNickname, CreateInvite.

---

## Search Security

Meilisearch indexes **message metadata only** — no plaintext content (E2EE). Enforces:
- Mandatory scoping by `server_id` or `channel_id`
- Membership verification
- Post-filter `ViewChannel` permission check per channel
- No server-side highlight content (XSS prevention)

---

## Rate Limiting

All services have per-IP rate limiting using in-memory token buckets:

| Endpoint Group | Rate | Burst |
|----------------|------|-------|
| Gateway WebSocket | 10 req/s | 3 |
| Auth endpoints | 5 req/s | 10 |
| Federation endpoints | 3 req/s | 5 |
| Keys endpoints | 20 req/s | 40 |

---

## Error Handling Conventions

- Use ConnectRPC error codes consistently (`CodeUnauthenticated`, `CodePermissionDenied`, `CodeNotFound`, `CodeAlreadyExists`, `CodeInvalidArgument`, `CodeInternal`)
- Wrap errors with context: `fmt.Errorf("insert message %s: %w", id, err)`
- Never expose internal error messages to clients

---

## Testing Strategy

- **Unit tests**: Table-driven tests in `_test.go` files per package
- **Integration tests**: `testcontainers-go` for PostgreSQL, ScyllaDB, Redis, NATS in Docker. Tag with `//go:build integration`
- **Load tests**: `k6` scripts in `scripts/loadtest/`

---

## Build and Run

```bash
# Build all services
go build -o bin/ ./cmd/...

# Run a service
MEZA_NATS_URL=nats://localhost:4222 ./bin/gateway

# Hot reload (development)
air -c .air.toml
```
