# API Reference

## Overview

Meza uses [ConnectRPC](https://connectrpc.com/) as its API layer. All APIs are defined in Protocol Buffers, and both Go server handlers and TypeScript clients are auto-generated from the same `.proto` files.

ConnectRPC supports three protocols simultaneously:
- **Connect protocol** — HTTP/1.1 + HTTP/2, works in browsers without a proxy
- **gRPC protocol** — Standard gRPC (HTTP/2 only)
- **gRPC-Web protocol** — For browser clients behind HTTP/1.1

All three use the same Protobuf definitions and generated code.

---

## Proto Definitions (Source of Truth)

The canonical API definitions live in `proto/meza/v1/`:

| File | Description |
|------|-------------|
| `models.proto` | Shared message types (User, Server, Channel, Message, etc.) |
| `auth.proto` | Registration, login, JWT, device management, profile updates |
| `chat.proto` | Messages, channels, servers, roles, invites, DMs, reactions, pins, emojis, soundboard, moderation, friends, blocks |
| `presence.proto` | Online/offline/idle/DND status, typing indicators |
| `media.proto` | File upload/download via pre-signed S3 URLs |
| `voice.proto` | LiveKit room management, WebRTC access tokens |
| `notification.proto` | Push notification preferences, VAPID key |
| `keys.proto` | E2EE public keys and ECIES-wrapped channel key envelopes |
| `gateway.proto` | WebSocket binary protocol (GatewayEnvelope, opcodes) |
| `federation.proto` | Cross-server federation (planned) |

**Always refer to the proto files for exact message definitions, field types, and field numbers.** The generated code in `server/gen/` (Go) and `client/gen/` (TypeScript) is the implementation of these definitions.

---

## Code Generation

```bash
# Generate Go + TypeScript from proto definitions
cd proto && buf generate

# Generate TypeScript only
cd client && pnpm codegen

# Lint protobuf files
cd proto && buf lint

# Check for breaking changes
cd proto && buf breaking --against '.git#subdir=proto'
```

Generated output:
- `server/gen/meza/v1/*.go` — Go server stubs and handlers
- `client/gen/meza/v1/*.ts` — TypeScript client code

Never edit generated files directly.

Buf configuration lives in `proto/buf.yaml` and `proto/buf.gen.yaml`.

---

## Authentication

All authenticated RPCs require a JWT in the `Authorization` header:

```
Authorization: Bearer <access_token>
```

JWTs are validated by the ConnectRPC auth interceptor. Public endpoints (Register, Login, GetSalt, RefreshToken) bypass authentication.

### Token Types

| Token | TTL | Purpose |
|-------|-----|---------|
| Access token | 1 hour | API authentication (HMAC-SHA256 or Ed25519) |
| Refresh token | 30 days | Rotated on each use, HttpOnly cookie |
| Federation assertion | 60 seconds | Audience-scoped, single-use for cross-server handshakes |

---

## Error Codes

All services use standard ConnectRPC error codes:

| Code | When |
|------|------|
| `CodeUnauthenticated` | Missing or invalid JWT |
| `CodePermissionDenied` | User lacks required permission |
| `CodeNotFound` | Resource doesn't exist |
| `CodeAlreadyExists` | Duplicate resource (e.g., username taken) |
| `CodeInvalidArgument` | Malformed request |
| `CodeInternal` | Unexpected server error |
| `CodeResourceExhausted` | Rate limit exceeded |

---

## Service Routing

The Vite dev server proxies ConnectRPC routes to backend services:

| Route | Target |
|-------|--------|
| `/meza.v1.AuthService` | `http://localhost:8081` |
| `/meza.v1.ChatService` | `http://localhost:8082` |
| `/meza.v1.PresenceService` | `http://localhost:8083` |
| `/meza.v1.MediaService` | `http://localhost:8084` |
| `/media` | `http://localhost:8084` |
| `/meza.v1.VoiceService` | `http://localhost:8085` |
| `/meza.v1.NotificationService` | `http://localhost:8086` |
| `/meza.v1.KeyService` | `http://localhost:8088` |
| `/meza.v1.FederationService` | `http://localhost:8081` |
| `/ws` | `ws://localhost:8080` (Gateway WebSocket) |

In production, Caddy reverse-proxies these routes to the appropriate services.

---

## WebSocket Gateway Protocol

The gateway uses a binary Protobuf protocol over WebSocket (see `gateway.proto`).

### Connection Sequence

```
Client                                  Gateway
  |                                        |
  |---- WebSocket Connect --------------->|
  |                                        |
  |---- OP_IDENTIFY { token } ----------->|
  |                                        |  Validate JWT
  |<---- OP_READY { user, servers,         |  Subscribe to NATS
  |       channels, session_id } ----------|
  |                                        |
  |---- OP_HEARTBEAT -------------------->|  (every 30s)
  |<---- OP_HEARTBEAT_ACK ---------------|
  |                                        |
  |<---- OP_EVENT { message_create } -----|  (from NATS)
  |                                        |
  |---- OP_SEND_MESSAGE { ... } --------->|  -> publishes to NATS
  |                                        |
```

### Reconnection and Resumption

```
Client                                  Gateway
  |                                        |
  |  (connection lost)                     |
  |                                        |
  |---- WebSocket Connect --------------->|
  |                                        |
  |---- OP_RESUME { session_id,            |
  |      last_sequence } ---------------->|
  |                                        |  Replay missed events
  |<---- OP_EVENT (missed) ---------------|  from NATS JetStream
  |<---- OP_EVENT (missed) ---------------|
  |<---- OP_READY { resumed: true } ------|
  |                                        |
```

---

## Rate Limiting

Rate limits are enforced per-service using in-memory token buckets:

| Endpoint | Rate Limit | Window |
|----------|-----------|--------|
| Register | 3 | per hour per IP |
| Login | 10 | per minute per IP |
| GetSalt | 10 | per minute per IP |
| SendMessage | 10 | per second per user |
| EditMessage | 5 | per second per user |
| Typing indicator | 5 | per 5 seconds per channel |
| CreateServer | 5 | per hour per user |
| CreateChannel | 10 | per minute per server |
| File upload | 10 | per minute per user |
| Voice join | 5 | per minute per user |

Rate limit headers returned:
```
X-RateLimit-Limit: 10
X-RateLimit-Remaining: 7
X-RateLimit-Reset: 1700000060
```
