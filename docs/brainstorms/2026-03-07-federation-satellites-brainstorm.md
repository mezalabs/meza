# Federation Satellites & Nodes Brainstorm

**Date:** 2026-03-07
**Status:** Draft
**Builds on:** `docs/brainstorms/2026-02-16-federation-brainstorm.md`, `docs/plans/2026-02-17-feat-federation-phase-1-plan.md`

---

## What We're Building

A "satellite" deployment model for Meza where community operators can self-host guild infrastructure while using meza.chat as the identity provider. Users sign in once on meza.chat and join guilds on any satellite — no additional accounts needed. The client manages connections to both meza.chat and each satellite, stitching them into a unified experience.

This builds on federation Phase 1 (server-side complete) and is primarily a client architecture change.

## Why This Approach

Federation Phase 1 already proved the identity model: meza.chat signs Ed25519 JWTs, remote instances verify via JWKS, shadow users represent federated members locally. But Phase 1 framed federation as peer-to-peer between full instances. The satellite model simplifies the "happy path" — most community operators don't want to run an identity provider, they just want to host guilds.

By leaning into the asymmetry (meza.chat = identity, satellite = guilds), we reduce the operator burden and make the client the natural integration point rather than requiring server-to-server coordination.

## Key Decisions

### 1. Community self-hosting is the primary use case

A guild owner/community wants to run their own guild infrastructure for control, privacy, or performance — but doesn't want to run an identity system. They sign in via meza.chat. This is the 95% case.

### 2. Client manages split connections

The client connects to meza.chat for identity/auth/DMs/keys and separately to each satellite for guild data. The client is the "glue" — satellites and meza.chat don't need to communicate with each other directly.

**Connection model:**
- One persistent WebSocket to meza.chat (identity, DMs, membership sync, key bundles)
- One WebSocket per satellite (guild channels, presence, media for that satellite's guilds)
- Client abstracts these into a unified event stream via a `ConnectionManager`

### 3. Open federation via JWKS (no satellite registration)

Any satellite can verify meza.chat tokens by fetching the public key from `/.well-known/jwks.json`. No pre-registration, no instance secrets, no allowlists. This is what Phase 1 already supports.

**Trust implications:**
- meza.chat doesn't know which satellites exist — it just publishes a JWKS endpoint
- The client decides which satellites to connect to (via invite links)
- Satellites verify identity cryptographically, not through a trust relationship with meza.chat

### 4. Trust model & E2EE from day one

The satellite model creates a clear trust spectrum:

| Layer | Guarantee |
|---|---|
| Identity/credentials | Never leave meza.chat |
| E2EE key bundles | Never touch satellite (Keys service is home-server-only) |
| Message content | Satellite sees ciphertext only (E2EE) |
| Metadata (who, when, where) | Satellite operator can see this |

Client fetches key bundles from meza.chat's Keys service, encrypts/decrypts locally, sends ciphertext to the satellite. This is already how federation was designed — the satellite never handles plaintext or private keys.

### 5. Configurable satellite service tiers

Minimal core (3 services + infra):
- **Gateway** — WebSocket connections, NATS routing, and federation RPCs (join/refresh/leave embedded directly)
- **Chat** — guilds, channels, messages, roles, members, invites
- **Presence** — online/offline/idle status, typing indicators
- **Infrastructure:** Postgres + NATS (+ Redis for presence TTL)

Optional add-ons the operator can enable:
- **Media** — file uploads, thumbnails (requires S3-compatible storage)
- **Voice** — voice channels (requires LiveKit)

A text-only community runs 3 services; a full-featured one runs 5. No auth service needed — federation is handled by the gateway.

### 6. meza.chat membership sync

meza.chat stores a list of `(satellite_url, guild_id)` tuples per user. When a user logs in on a new device, the client fetches this list to know which satellites to reconnect to. This enables multi-device without the user manually re-joining satellites.

The sync is lightweight — meza.chat stores URLs and guild IDs, not guild content or membership details.

### 7. DMs route through meza.chat only

All DMs go through meza.chat regardless of where users met. Satellites handle guild channels exclusively. Push notifications for DMs come from meza.chat; push notifications for guild mentions come from each satellite independently.

This keeps DMs on the trusted identity provider and avoids satellites needing to relay messages between users who may be on different satellites.

## Approach: Multi-Connection Client

The client maintains N+1 WebSocket connections:

```
┌──────────────┐
│    Client     │
│ (ConnectionMgr)│
├──────┬───────┤
│ WS 0 │ WS 1  │ WS 2  ...
│      │       │
▼      ▼       ▼
meza.chat  satellite-a.example.com  satellite-b.org
(identity,  (guild channels,         (guild channels,
 DMs, keys,  presence, media)         presence)
 sync)
```

**Why this over alternatives:**
- **vs. Proxy through meza.chat:** Would make meza.chat a bottleneck, break the self-hosting value prop, and add complexity to relay E2EE ciphertext
- **vs. Service worker multiplexer:** Only helps web; Electron and mobile wouldn't use it. Adds complexity without enough benefit.

**Client implementation concerns:**
- Reconnection logic per connection (independent retry with backoff)
- Unified notification/event stream across all connections
- Token lifecycle: meza.chat access token + per-satellite federation tokens with independent refresh cycles
- Connection state UI: show per-satellite connection status

## Resolved Questions

### Federation auth shim → Embed in gateway

Federation RPCs (FederationJoin, FederationRefresh, FederationLeave) will be embedded directly in the gateway binary. The gateway already has PostgreSQL, JWT signing, and ChatStore. The only additions are FederationStorer (~131 lines), AuthStorer (for GetUserByID), InviteStorer (for ConsumeInvite), and the JWKS verifier.

This means a satellite's minimum deployment is: **Gateway (single binary) + Postgres + NATS**. No auth service needed on satellites.

### Profile sync → Client pushes on connect

Each time the client connects to a satellite, it sends the user's latest profile (display name, avatar) from meza.chat. The satellite updates the shadow user row. No server-to-server calls needed. Profile is stale only while the user is disconnected — acceptable tradeoff for simplicity.

### Push notifications → Relay through meza.chat

Satellites send notification payloads to meza.chat, which pushes to the user's devices. Users maintain a single push subscription (with meza.chat). This is the one server-to-server dependency in the satellite model: satellites need to call meza.chat's notification relay endpoint. meza.chat sees notification metadata (which satellite, notification type) but not message content (E2EE).

Note: This means meza.chat does learn which satellites are active (via incoming relay calls), which is a slight tension with the "meza.chat doesn't know satellites exist" principle from decision 3. The tradeoff is accepted because: (a) the alternative (per-satellite VAPID keys) puts significant ops burden on community operators, and (b) notification metadata is lower sensitivity than guild content.

### Version compatibility → WebSocket handshake + authenticated capability check

No public `/.well-known/meza.json` — that leaks instance metadata to unauthenticated observers. Instead:

1. **Protocol version** is exchanged during the WebSocket upgrade (part of the initial handshake, already authenticated via federation token)
2. **Feature capabilities** (media, voice, etc.) are returned as part of the authenticated connection payload — only visible to users who have already joined a guild on that satellite

This means you can't fingerprint a satellite's capabilities without being a member. The client adapts its UI (e.g., hide voice channels) based on capabilities received post-auth.

### Offline satellites → Greyed-out guilds with auto-reconnect

When a satellite is unreachable, its guilds appear greyed out in the sidebar with a connection status indicator. Client uses exponential backoff for reconnection attempts. Cached channel/message data remains visible (read-only) if available locally.
