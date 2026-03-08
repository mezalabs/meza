---
title: "feat: Federation Satellites & Nodes — Implementation Plan"
type: feat
status: completed
date: 2026-03-07
deepened: 2026-03-07
supersedes: docs/plans/2026-03-07-feat-federation-satellites-primary-model-plan.md (positioning absorbed), docs/plans/2026-02-17-feat-federation-phase-1-plan.md (Phase B absorbed)
brainstorm: docs/brainstorms/2026-03-07-federation-satellites-brainstorm.md
---

# Federation Satellites & Nodes — Implementation Plan

## Enhancement Summary

**Deepened on:** 2026-03-07
**Review agents used:** Architecture Strategist, Security Sentinel, Performance Oracle, Race Condition Reviewer, Spec Flow Analyzer, Data Integrity Guardian, Code Simplicity Reviewer, Pattern Recognition Specialist
**Institutional learnings applied:** WebSocket Gateway Reliability, Gateway NATS Deserialization Cascade, NATS Events Audit, MLS External Join Serialization

### Critical Findings Requiring Action

| Priority | Finding | Source | Action |
|----------|---------|--------|--------|
| CRITICAL | Missing `ON DELETE CASCADE` on `federated_memberships.user_id` FK | Data Integrity | Fix DDL |
| CRITICAL | `FederationLeave` does not revoke satellite tokens | Security | Add token blocklist on leave |
| CRITICAL | JTI claim not mandatory — replay protection bypassable | Security | Make `jti` required, reject if missing |
| HIGH | `disconnectAll` vs `connectInstance` race — ghost guilds after logout | Race Conditions | Per-instance generation counter + `isShuttingDown` flag |
| HIGH | Store cleanup vs stale event dispatch — blank screen flash | Race Conditions | Check connection existence before dispatch |
| HIGH | Redundant index `idx_federated_memberships_user` (PK covers it) | Data Integrity | Remove index |
| HIGH | No cleanup strategy for stale federated memberships | Data Integrity | Add reconciliation on session start |
| HIGH | Invite consumption outside join transaction — burns invite on failure | Spec Flow | Move `ConsumeInvite` inside `FederationJoinTx` |
| MEDIUM | Refresh token TTL mismatch: code=30d, plan=7d | Security | Add `federatedRefreshTokenExpiry = 7d` |
| MEDIUM | HTTP scheme accepted for assertion target URLs | Security | Reject `http://` in production |
| MEDIUM | No rate limit on `CreateFederationAssertion` | Security + Performance | Add per-user 10 req/min |
| MEDIUM | Channel key envelopes lack integrity protection (malicious satellite can substitute) | Security | Sign envelopes with rotator's Ed25519 key |
| MEDIUM | Redis nil silently disables JTI replay protection | Security | Startup validation: refuse federation without Redis |
| MEDIUM | READY payload uses JSON-in-protobuf but plan proposes proto message | Pattern | Decide: add capabilities to JSON blob or migrate to full proto |
| MEDIUM | FederationService proto split across two binaries (partial impl) | Pattern | Consider `HomeFederationService` / `SatelliteFederationService` split |
| MEDIUM | Heartbeat coordinator cascade failure — one stalled connection kills all | Race Conditions | Independent try/catch per connection in heartbeat loop |

### Simplification Recommendations

| Item | Recommendation | Impact |
|------|---------------|--------|
| `UpdateFederatedProfile` RPC | Remove — `FederationRefresh` already syncs profiles via assertion claims (~45min cadence) | -1 RPC, -1 proto message, -1 file |
| Single heartbeat coordinator | Defer — keep per-connection timers for MVP; batch when mobile client exists | Remove Phase B Step 3 |
| 4-variant Instance type | Simplify to `{ url, accessToken?, refreshToken?, capabilities?, connected: boolean }` for MVP | Simpler consumers |
| Phase C3 (UX polish) | Defer to post-MVP alongside Phase D | Clearer milestone: "satellites work" vs "satellites are polished" |
| Two-level store nesting | Consider alternative: add `instanceUrl` field to entities, keep flat stores with helper selectors | Reduce blast radius of refactor |

### Performance Optimizations

| Optimization | Priority | Impact |
|-------------|----------|--------|
| Add `CreateFederationAssertions` (plural) batch RPC | High | Collapse N assertion requests into 1 RTT during refresh cascade |
| Add jitter to 75% TTL refresh trigger (`Math.random() * 0.1 * TTL`) | High | Prevent thundering herd — zero-cost |
| Conditional profile push: `WHERE display_name IS DISTINCT FROM $2` | High | Eliminate write amplification on reconnects |
| Shadow-to-home user ID lookup map (`Map<shadowId, homeId>`) | High | O(1) presence resolution vs O(N*M) scanning |
| Concurrency limiter (3-5) for satellite reconnects | Medium | Reduce mobile connection contention |
| Message store: flat keys with instance prefix (avoid Immer proxy multiplication) | Medium | Avoid 8×20=160 proxy paths per mutation |

## Overview

Complete the satellite federation model: community operators self-host guild infrastructure (Gateway + Chat + Presence, optionally Media + Voice) while meza.chat provides identity, DMs, and key custody. The client manages N+1 WebSocket connections, stitching everything into a unified experience.

Phase A (server-side federation RPCs, Ed25519, JWKS, shadow users) is **complete**. This plan covers everything remaining: embedding federation in the gateway, client multi-connection architecture, membership sync, notification relay, capability advertisement, and E2EE integration.

## Problem Statement

The client is a single-connection singleton. All 26 Zustand stores, the gateway module, the API transport, and the UI assume one server. Federation Phase A built the server-side identity model but the client cannot use it. Additionally, satellite-specific server features (gateway-embedded federation, capability advertisement, membership sync, notification relay) do not exist yet.

## Key Design Decisions

Carried from brainstorm + Phase 1 plan. These are **settled** — implementation should follow them.

| # | Decision | Source |
|---|----------|--------|
| 1 | meza.chat = sole identity provider (Phase 1) | Phase 1 plan |
| 2 | Client manages N+1 WebSocket connections directly | Brainstorm |
| 3 | Open JWKS verification, no satellite registration | Brainstorm |
| 4 | E2EE from day one — satellite sees ciphertext only | Brainstorm |
| 5 | Federation RPCs embedded in gateway (not auth service) | Brainstorm |
| 6 | Configurable satellite service tiers (core + addons) | Brainstorm |
| 7 | meza.chat stores membership sync tuples | Brainstorm |
| 8 | DMs route through meza.chat only | Brainstorm |
| 9 | Profile sync via client push on connect | Brainstorm |
| 10 | Capabilities in authenticated WebSocket handshake, not public endpoint | Brainstorm |
| 11 | Two-level nested Zustand stores `Record<instanceUrl, Record<entityId, T>>` | Phase 1 plan |
| 12 | Module-scoped `Map<string, Connection>` (not class-based) | Phase 1 plan |
| 13 | Single heartbeat coordinator for all connections | Phase 1 plan |
| 14 | Re-fetch on reconnect (no event replay) | Phase 1 plan |
| 15 | Proactive token refresh at 75% of TTL | Phase 1 plan |

### Research Insights: Design Decisions

**Decision #3 clarification (Architecture Review):** "Open JWKS" means satellites don't register with meza.chat — the *client* discovers satellites via invite links. The satellite-side verifier correctly uses a `TRUSTED_HOME_SERVERS` allowlist to verify assertions. This is not contradictory: "open" refers to the discovery model, not the verification model. Make this explicit in documentation.

**Decision #9 reconsideration (Simplicity Review):** `UpdateFederatedProfile` adds a new RPC, proto message, gateway endpoint, and NATS broadcast. But `FederationRefresh` already carries updated profile claims in the assertion and updates the shadow user if they differ (~45min cadence). The plan itself says "users change profiles rarely." **Recommendation: Remove `UpdateFederatedProfile` and rely on `FederationRefresh` lazy sync for MVP.** Add a dedicated push mechanism only if users report stale profiles as a problem.

**Decision #11 alternatives (Architecture + Simplicity Reviews):** The two-level `Record<instanceUrl, Record<entityId, T>>` pattern touches 6+ stores and every UI component. Two alternatives to evaluate:
- **Flat stores with `instanceUrl` field:** Add `instanceUrl` to each entity type (Server, Channel, etc.). Selectors filter by instance. Cleanup: filter and delete. Entity IDs are ULIDs — globally unique, no collision risk. Minimally invasive.
- **Store-per-instance factory:** Each satellite connection creates isolated store instances. UI layer merges. Clean separation, memory overhead.

**Decision #13 deferral (Simplicity + Race Condition Reviews):** The single heartbeat coordinator adds coordination complexity (what if one connection stalls during iteration?) and is premature for web/desktop where N<20 and browser event loops coalesce timers. **Recommendation: Keep per-connection heartbeat timers for MVP. Each connection's heartbeat is independently guarded with try/catch. Add batching only when a mobile client exists with measured battery problems.**

## Technical Approach

### Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                        Client                           │
│  ┌─────────────────────────────────────────────────┐    │
│  │              ConnectionManager                   │    │
│  │  Map<instanceUrl, Connection>                    │    │
│  │  Single heartbeat coordinator (30s batch)        │    │
│  ├──────────┬──────────┬──────────┬────────────┤    │
│  │ Home WS  │ Sat-A WS │ Sat-B WS │ ...        │    │
│  └────┬─────┴────┬─────┴────┬─────┴────────────┘    │
│       │          │          │                         │
│  ┌────┴──────────┴──────────┴────────────────────┐    │
│  │     Instance-Aware Zustand Stores (26+)       │    │
│  │  Record<instanceUrl, Record<entityId, T>>     │    │
│  └───────────────────────────────────────────────┘    │
└───────────┬──────────┬──────────┬────────────────────┘
            │          │          │
       meza.chat    sat-a.org   sat-b.net
       (identity,   (guilds,    (guilds,
        DMs, keys,   presence,   presence)
        sync)        media)
```

### Satellite Minimum Deployment

```
┌─────────────────────────────────────┐
│         Satellite Instance          │
│                                     │
│  ┌──────────┐  ┌──────────┐        │
│  │ Gateway  │  │   Chat   │        │
│  │ (+ fed   │  │          │        │
│  │  RPCs)   │  │          │        │
│  └────┬─────┘  └────┬─────┘        │
│       │              │              │
│  ┌────┴──────────────┴─────┐        │
│  │       PostgreSQL        │        │
│  │  (users, servers,       │        │
│  │   channels, members,    │        │
│  │   messages, roles...)   │        │
│  └─────────────────────────┘        │
│                                     │
│  ┌──────────┐  ┌──────────┐        │
│  │ Presence │  │   NATS   │        │
│  └──────────┘  └──────────┘        │
│                                     │
│  ┌──────────┐  ┌──────────┐        │
│  │  Redis   │  │ ScyllaDB │        │
│  │(presence │  │(messages)│        │
│  │ + jti)   │  │          │        │
│  └──────────┘  └──────────┘        │
│                                     │
│  Note: Redis is required for        │
│  presence TTL and jti replay        │
│  protection. ScyllaDB is required   │
│  for message storage.               │
│                                     │
│  Optional:                          │
│  ┌──────────┐  ┌──────────┐        │
│  │  Media   │  │  Voice   │        │
│  │  (+ S3)  │  │(+LiveKit)│        │
│  └──────────┘  └──────────┘        │
└─────────────────────────────────────┘
```

### E2EE Key Distribution for Satellite Channels

This is architecturally significant. Identity key bundles (Ed25519 signing keys, X25519 prekeys) stay on meza.chat's Keys service. But **channel key envelopes** (the per-channel symmetric keys encrypted to each member's public key) need a home for satellite guilds.

**Approach:** Satellite channels store key envelopes locally on the satellite. The Chat service on the satellite handles `KeyEnvelopeStorer` RPCs (`StoreKeyEnvelopes`, `GetKeyEnvelopes`, `RotateChannelKey`) — the satellite does **not** need to run the full Keys service. These RPCs are already defined in the chat proto and the Chat service already has the store interface.

**Flow:**
1. Guild creator generates channel key, encrypts to own public key, stores envelope on satellite's Chat service
2. New member joins via invite → invite carries `encrypted_channel_keys` (already implemented in invite model)
3. For ongoing key rotation or new channels after join → the rotating member uploads new envelopes to the satellite for each member
4. Members fetch key envelopes from the satellite's Chat service, decrypt with their private key (private key lives in their identity key bundle on meza.chat, fetched once on login)

**Trust analysis:** The satellite stores encrypted key envelopes (ciphertext). It cannot decrypt them without the member's private key (which lives on meza.chat). This is the same trust model as storing encrypted messages — the satellite holds ciphertext it cannot read.

**Security Review — Integrity gap (MEDIUM):** A malicious satellite operator could *replace* envelopes with ones encrypted to a key they control, causing the member to use an operator-chosen channel key. Subsequent messages would be readable by the operator. **Mitigation: Channel key envelopes must be signed by the rotating member's Ed25519 signing key (from their identity key bundle on meza.chat). Recipients verify the signature before accepting a new key envelope.** Additionally, envelopes should include a monotonic version counter to detect stale-serving attacks.

**What stays on meza.chat:** Identity key bundles (`user_auth.encrypted_key_bundle`), signing keys, prekey bundles. The Keys service's `UploadKeyBundle` / `GetKeyBundle` RPCs remain home-server-only. The Keys service is **not** part of the satellite minimum deployment.

**What lives on the satellite:** Channel key envelopes for that satellite's channels. Handled by the Chat service's existing `KeyEnvelopeStorer` interface.

### Notification Relay Authentication

Satellites need to relay push notifications to meza.chat. The authentication model:

**Approach:** meza.chat-issued relay authorization tokens. During `FederationRefresh`, the client requests a relay authorization token from meza.chat (not the satellite) scoped to a specific satellite URL. The client delivers this token to the satellite. The satellite caches it and uses it to authenticate relay calls to meza.chat. This way meza.chat only verifies its own tokens on the relay endpoint — consistent with "meza.chat = sole identity provider" and "no satellite registration."

**Why meza.chat issues the token (not the satellite):** If the satellite issued relay tokens, meza.chat would need to verify tokens signed by arbitrary unregistered satellites. This contradicts Decision #3 (open JWKS, no satellite registration). By having meza.chat issue the token, meza.chat only trusts its own signatures.

**Constraints:**
- Relay token has longer TTL than assertions (7 days, matching satellite refresh token)
- Contains: `sub` (home_user_id), `aud` (meza.chat relay endpoint), `satellite_url`, `purpose: "notification_relay"`
- Refreshed on each `FederationRefresh` cycle (client obtains new relay token from meza.chat, delivers to satellite)

**Plan decision:** Start with client-side notifications only (Phases B/C). Add server-side relay in Phase D (post-MVP) with meza.chat-issued relay tokens.

### FederationJoin Response Hydration

The current `FederationJoinResponse` returns `{server, channels, members, access_token, refresh_token, user_id}`. Missing: roles, channel groups, permission overrides, emojis, soundboard sounds.

**Approach:** After `FederationJoin`, the client makes standard ConnectRPC calls to the satellite to fetch remaining state (same as the normal guild join flow). The join response provides enough to render the sidebar immediately; the client hydrates details in parallel.

Specifically, after join the client calls:
- `ListRoles(server_id)` → role colors, permissions
- `ListChannelGroups(server_id)` → sidebar organization
- `ListEmojis(server_id)` → custom emoji
- Read states are initialized fresh (no history)

This avoids expanding the join response proto and reuses existing RPCs.

---

## Implementation Phases

### Phase A: Server — Embed Federation in Gateway + Satellite Config

Move federation RPCs from auth service to gateway. Add capability advertisement to READY payload. Add satellite-specific configuration.

**Move Federation RPCs to Gateway:**

- [ ] Add `FederationStorer` initialization to `server/cmd/gateway/main.go`
  - `store.NewFederationStore(pool)` — uses existing Postgres pool
- [ ] Add `AuthStorer` initialization (for `GetUserByID` in FederationRefresh)
  - `store.NewAuthStore(pool)` — uses existing Postgres pool
- [ ] Add `InviteStorer` initialization (for `ConsumeInvite` in FederationJoin)
  - `store.NewInviteStore(pool)` — uses existing Postgres pool
- [ ] Add `federation.Verifier` setup to gateway
  - Initialize `federation.JWKSClient` with `TrustedHomeServers` from config
  - Call `EagerLoad()` on startup (blocks until JWKS fetched)
  - Start `BackgroundRefresh()` goroutine
  - `server/internal/federation/jwks_client.go` (existing, no changes)
- [ ] Add optional Redis client to gateway (for jti replay protection)
  - Conditional: only initialized when `MEZA_FEDERATION_ENABLED=true`
  - Used by `FederationJoin` and `FederationRefresh` for assertion jti dedup
- [ ] Create `server/cmd/gateway/federation_service.go` (new)
  - Move `FederationJoin`, `FederationRefresh`, `FederationLeave` handler implementations from `server/cmd/auth/federation_service.go`
  - Keep `CreateFederationAssertion`, `ResolveRemoteInvite`, `ListFederatedMemberships` on auth service (these are home-server-only RPCs)
  - Wire federation service to gateway's ConnectRPC mux
- [ ] Update `server/cmd/auth/federation_service.go`
  - Remove `FederationJoin`, `FederationRefresh`, `FederationLeave` implementations
  - These RPCs return `CodeUnimplemented` on the auth service (or remove from auth's service registration entirely)
  - Keep `CreateFederationAssertion`, `ResolveRemoteInvite`, `ListFederatedMemberships`
- [ ] Register `FederationService` on gateway's HTTP mux alongside the WebSocket handler
  - Federation RPCs served at the same host:port as WebSocket connections
  - Existing CORS middleware applies

**Capability Advertisement in READY Payload:**

- [ ] Add `capabilities` field to `GatewayReadyPayload` in `proto/meza/v1/gateway.proto`
  ```protobuf
  message GatewayReadyPayload {
    // ... existing fields ...
    InstanceCapabilities capabilities = 10;
  }

  message InstanceCapabilities {
    uint32 protocol_version = 1;     // Increment on breaking changes
    bool media_enabled = 2;          // Media service available
    bool voice_enabled = 3;          // Voice service available
    bool notifications_enabled = 4;  // Push notification relay available
  }
  ```
- [ ] Populate capabilities in gateway READY handler based on config
  - Media: check if `MEZA_S3_ENDPOINT` is configured
  - Voice: check if `MEZA_LIVEKIT_URL` is configured
  - Protocol version: hardcoded constant, incremented on breaking changes
- [ ] Run `buf generate` after proto changes

**Profile Push Endpoint:**

- [ ] Add `UpdateFederatedProfile` RPC to `FederationService` on gateway
  ```protobuf
  rpc UpdateFederatedProfile(UpdateFederatedProfileRequest) returns (UpdateFederatedProfileResponse);

  message UpdateFederatedProfileRequest {
    string display_name = 1;
    string avatar_url = 2;
  }
  ```
  - Authenticated via satellite-issued JWT (federated users only)
  - Calls `federationStore.UpdateShadowUserProfile()`
  - Broadcasts profile change to other connected clients on the satellite via NATS `meza.server.member.<serverID>` (so other users see updated display name/avatar)
  - Returns success/failure
- [ ] Client calls this on each satellite WebSocket connect (Phase C1)

**Gateway ConnectRPC Mux:**

- [ ] Add ConnectRPC handler to gateway's `http.ServeMux`
  - The gateway currently only serves WebSocket (`/ws`) and health (`/health`) endpoints on a plain `http.ServeMux`
  - Adding `FederationService` ConnectRPC requires integrating the Connect handler into this mux (same pattern as auth and chat services use)
  - Ensure CORS middleware applies to ConnectRPC routes (federation RPCs called cross-origin by clients)
  - Middleware ordering: CORS → rate limiting → ConnectRPC handler

**Files touched:**
- `proto/meza/v1/gateway.proto` (modify — capabilities, ConnectRPC service)
- `proto/meza/v1/federation.proto` (modify — UpdateFederatedProfile)
- `server/cmd/gateway/main.go` (modify — stores, verifier, federation service, ConnectRPC mux)
- `server/cmd/gateway/federation_service.go` (new — moved from auth)
- `server/cmd/auth/federation_service.go` (modify — remove satellite RPCs)
- `server/cmd/auth/main.go` (modify — update service registration)

**Success criteria:**
- `FederationJoin` works when called on the gateway endpoint (not auth)
- `FederationRefresh` and `FederationLeave` work on gateway
- `CreateFederationAssertion` still works on auth service
- READY payload includes `capabilities` with correct feature flags
- `UpdateFederatedProfile` updates shadow user display_name/avatar
- `task test:server` passes
- Satellite with Gateway + Chat + Presence + Postgres + NATS + Redis + ScyllaDB can accept federation joins without running the auth service

**meza.chat Membership Sync (bundled with Phase A):**

- [ ] Add `federated_memberships` table via migration
  ```sql
  CREATE TABLE federated_memberships (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    satellite_url TEXT NOT NULL CHECK (
      satellite_url ~ '^https://' AND length(satellite_url) <= 2048
    ),
    server_id TEXT NOT NULL,
    joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, satellite_url, server_id)
  );
  -- NOTE: No separate index on user_id — the PK index (user_id, satellite_url, server_id)
  -- already serves WHERE user_id = $1 queries efficiently.
  ```
  Note: No `server_name` or `server_icon_url` columns — these go stale immediately when someone renames a guild. The client fetches real server data from the satellite on connect. The sidebar shows the satellite URL while connecting, then swaps in the real name.

  **Data Integrity Review findings applied:**
  - `ON DELETE CASCADE` added to match every other user-referencing table in the schema (prevents blocking user deletion)
  - `CHECK` constraint enforces HTTPS and max length (prevents URL abuse in PK index)
  - Redundant `idx_federated_memberships_user` index removed (PK already covers `user_id` queries)
  - Down migration: `DROP TABLE IF EXISTS federated_memberships;`
- [ ] Add `FederatedMembershipStorer` interface to `server/internal/store/interfaces.go`
  ```go
  type FederatedMembershipStorer interface {
    AddFederatedMembership(ctx context.Context, userID, satelliteURL, serverID string) error
    RemoveFederatedMembership(ctx context.Context, userID, satelliteURL, serverID string) error
    ListFederatedMemberships(ctx context.Context, userID string) ([]FederatedMembership, error)
  }
  ```
- [ ] Implement `FederatedMembershipStore` in `server/internal/store/federated_membership_store.go` (new)
- [ ] Replace `ListFederatedMemberships` stub in `server/cmd/auth/federation_service.go`
  - Query `federated_memberships` table for authenticated user
  - Return list of `{satellite_url, server_id, joined_at}`
- [ ] Add `StoreFederatedMembership` and `RemoveFederatedMembership` RPCs to `FederationService` in auth
  - Authenticated via meza.chat JWT (not federated — only home users)
  - Client calls these after successful `FederationJoin` / `FederationLeave`
  - Duplicate stores are idempotent (upsert via `ON CONFLICT DO NOTHING`)

**Security Hardening (bundled with Phase A — from Security Review):**

- [ ] Make `jti` claim mandatory in assertion verification (H1)
  - After `VerifyAssertion` succeeds, extract `jti` and reject if missing or empty
  - Do not nest in conditional guards — explicit rejection
- [ ] Add token blocklist on `FederationLeave` (H3)
  - On `FederationLeave`, add the shadow user's `deviceID` to the `TokenBlocklist` (existing Redis-based blocklist)
  - Ensures satellite-issued tokens are rejected immediately after leave
- [ ] Add `federatedRefreshTokenExpiry = 7 * 24 * time.Hour` constant (M1)
  - Use in `generateLocalTokenPair` when `isFederated` is true
  - Current code uses 30-day TTL for all tokens — plan specifies 7 days for federated
- [ ] Reject `http://` scheme in `CreateFederationAssertion` and `ResolveRemoteInvite` (M2)
  - Allow `http://` only when `MEZA_DEV_MODE=true`
- [ ] Add per-user rate limit on `CreateFederationAssertion` (M3)
  - 10 requests/minute per user (covers 10 satellites refreshing with headroom)
  - Use existing Redis rate limiting infrastructure
- [ ] Startup validation: refuse `MEZA_FEDERATION_ENABLED=true` without Redis (M5)
  - Current `consumeJTI` silently returns `true` when `redisClient == nil` — deployment footgun
- [ ] Move `ConsumeInvite` inside `FederationJoinTx` transaction (Spec Flow)
  - Current ordering burns invite uses on join failures
  - Invite consumption must be atomic with shadow user creation
- [ ] Wire `FEDERATION_REMOVED` event emission in Chat service ban/kick handlers (Spec Flow)
  - Proto message exists (`FederationRemovedEvent`) but no code publishes it
  - Check `is_federated` on target user and emit via NATS

**Additional Phase A files touched:**
- `proto/meza/v1/federation.proto` (modify — membership messages + RPCs)
- `server/internal/store/interfaces.go` (modify)
- `server/internal/store/federated_membership_store.go` (new)
- `server/cmd/auth/federation_service.go` (modify — implement ListFederatedMemberships, add Store/Remove)
- `server/cmd/auth/main.go` (modify — wire new store)
- `server/migrations/{ts}_add_federated_memberships.up.sql` (new)
- `server/migrations/{ts}_add_federated_memberships.down.sql` (new)

**Additional success criteria:**
- `StoreFederatedMembership` persists a (user, satellite, server) tuple
- `ListFederatedMemberships` returns all memberships for a user
- `RemoveFederatedMembership` removes a specific membership
- `task test:server` passes

---

### Phase B: Client — Multi-Connection Foundation

Refactor the client from single-connection singleton to multi-instance architecture. This is the largest phase and the foundation everything else builds on.

**Step 1: Extract Connection Module**

- [ ] Create `client/packages/core/src/gateway/connection.ts` (new)
  - Extract connection lifecycle from `gateway.ts` into a standalone module
  - `Connection` type: `{ url, ws, status, generation, heartbeatAck, reconnectAttempt, token, deviceId }`
  - Exported functions: `createConnection(url, token)`, `closeConnection(conn)`, `sendOnConnection(conn, op, payload)`
  - Heartbeat logic per connection (send heartbeat, track ACK, force-close on timeout)
  - Reconnect logic per connection (exponential backoff, 1s to 30s cap, network-aware pause)
  - Generation counter per connection (prevents stale callbacks)
- [ ] `gateway.ts` becomes a thin adapter delegating to one connection instance
  - All 40+ existing gateway tests must pass unchanged against the adapter
  - No behavioral changes — pure refactor
- [ ] Add tests for connection module in `client/packages/core/src/gateway/connection.test.ts` (new)
  - Heartbeat send/ACK/timeout
  - Reconnect backoff
  - Generation counter preventing stale callbacks

**Step 2: Multi-Instance Connection Support**

- [ ] Create module-scoped `Map<string, Connection>` in `gateway.ts`
  - Key: instance URL (normalized: lowercase hostname, no trailing slash, HTTPS enforced)
  - Home instance uses constant key `"home"` (or the meza.chat URL)
- [ ] Exported functions:
  - `connectInstance(instanceUrl, token)` — creates Connection, adds to map
  - `disconnectInstance(instanceUrl)` — closes Connection, removes from map
  - `disconnectAll()` — closes all connections
  - `sendToInstance(instanceUrl, op, payload)` — route message to specific connection
  - `getConnectionStatus(instanceUrl)` — returns connection status
- [ ] Event dispatch with instance context
  - Pass `instanceUrl` as a parameter to the dispatch function (not a module-scoped mutable sentinel — avoids fragile global state even though JS is single-threaded)
  - Stores receive `instanceUrl` in each action to route to correct instance bucket
  - Wrap per-instance dispatch in try/catch (one instance's error must not affect others)
  - Per institutional learning: use discriminated union dispatch (`else if` chains) to ensure all event types handled

**Step 3: Single Heartbeat Coordinator**

- [ ] Replace per-connection heartbeat timers with one `setInterval` (30s)
  - Iterates all connections in the map
  - Sends heartbeat to each, checks ACK timeout for each
  - Converts O(N) radio wakes into O(1) per interval — critical for mobile battery
- [ ] Heartbeat ACK validation per institutional learning:
  - Track `lastHeartbeatAck` timestamp per connection
  - Force-close if >45s elapsed (1.5 cycles) without ACK

**Instance Store:**

- [ ] Create `client/packages/core/src/store/instances.ts` (new)
  - Tracks per-instance state: connection status, tokens, capabilities, metadata
  - Discriminated union on status:
    ```typescript
    type Instance =
      | { status: 'connecting'; url: string }
      | { status: 'connected'; url: string; accessToken: string; refreshToken: string; capabilities: InstanceCapabilities }
      | { status: 'reconnecting'; url: string; accessToken: string; refreshToken: string; attempt: number }
      | { status: 'error'; url: string; error: string }
    ```
  - Persist instance URLs and tokens in `localStorage` as `meza:instances` (cache only)
  - On login: fetch from `ListFederatedMemberships` (meza.chat) — server is source of truth, overwrites localStorage
  - `addInstance`, `removeInstance`, `updateInstanceStatus`, `updateInstanceTokens`

**State Management — Two-Level Nesting:**

- [ ] Update priority Zustand stores to use `Record<instanceUrl, Record<entityId, T>>`
  - Convert these stores (minimum for satellite guilds to work):
    - `servers.ts` — `Record<instanceUrl, Record<serverId, Server>>`
    - `channels.ts` — `Record<instanceUrl, Record<channelId, Channel>>`
    - `members.ts` — `Record<instanceUrl, Record<serverId, Record<userId, Member>>>`
    - `messages.ts` — `Record<instanceUrl, Record<channelId, Message[]>>`
    - `roles.ts` — `Record<instanceUrl, Record<roleId, Role>>`
    - `presence.ts` — merge presence across instances (online on any = globally online, using `home_user_id` for correlation)
  - Defer secondary stores until needed: `readState.ts`, `typing.ts`, `reactions.ts`, `pins.ts`, `emojis.ts`, `soundboard.ts` — these can be converted when satellite data actually flows through them
  - Home instance uses known constant key
  - Existing selectors default to home instance for backward compatibility
  - O(1) cleanup when an instance disconnects: `delete stores[instanceUrl]`
  - Per institutional learning: proto events must be self-contained — include instance context in dispatch, don't rely on client-side state maps that may not be populated at cold start

**API Transport:**

- [ ] Update `client/packages/core/src/api/client.ts` for per-instance transports
  - Home: relative URL (existing Vite proxy)
  - Satellites: absolute URL with CORS
  - Per-instance `refreshPromise` deduplication (not one global)
  - `getTransport(instanceUrl)` — returns or creates transport for instance
  - Interceptor-level retry: on `CodeUnauthenticated`, trigger assertion + refresh, retry once
  - Existing API functions work unchanged for home instance (backward compatible)

**Files touched:**
- `client/packages/core/src/gateway/connection.ts` (new)
- `client/packages/core/src/gateway/connection.test.ts` (new)
- `client/packages/core/src/gateway/gateway.ts` (major refactor)
- `client/packages/core/src/gateway/gateway.test.ts` (preserve, extend)
- `client/packages/core/src/store/instances.ts` (new)
- `client/packages/core/src/store/servers.ts` (modify — two-level nesting)
- `client/packages/core/src/store/channels.ts` (modify)
- `client/packages/core/src/store/members.ts` (modify)
- `client/packages/core/src/store/messages.ts` (modify)
- `client/packages/core/src/store/roles.ts` (modify)
- `client/packages/core/src/store/presence.ts` (modify)
- `client/packages/core/src/api/client.ts` (modify — transport registry)

**Success criteria:**
- Client connects to home instance + N satellite instances simultaneously
- Messages from different instances route to correct store buckets
- Disconnecting one instance does not affect others
- Heartbeats batched across all connections (one timer)
- Existing 40+ gateway tests pass after each refactor step
- Losing connection to one satellite shows reconnecting state for that satellite only
- `task test:client` passes

### Research Insights: Phase B Race Conditions

**From Race Condition Review (10 identified, 4 HIGH severity):**

1. **`disconnectAll` vs `connectInstance` race (HIGH):** If a user logs out while a satellite is mid-join, `disconnectAll()` fires but the join callback later calls `connectInstance()`. The ghost connection has no matching auth state. **Mitigation:** Add a per-instance generation counter. `disconnectAll()` increments a global generation. `connectInstance` checks the generation before proceeding — if it changed, abort. Additionally, set an `isShuttingDown` flag that `connectInstance` checks.

2. **Store cleanup vs stale event dispatch (HIGH):** `disconnectInstance()` clears the store bucket for that instance, but a WebSocket `onmessage` callback may still fire (event loop timing). The dispatch targets a deleted store key → blank data flash. **Mitigation:** Check `connections.has(instanceUrl)` at the top of the event dispatch function before touching stores. If the connection was removed, drop the event silently.

3. **Heartbeat cascade failure (HIGH):** A single heartbeat coordinator iterating all connections means one stalled `ws.send()` (e.g., on a saturated connection) blocks heartbeats to all other connections. **Mitigation:** Wrap each connection's heartbeat send in an independent `try/catch`. If one fails, log and continue to the next. Better yet: keep per-connection heartbeat timers for MVP (see Decision #13 deferral above).

4. **Presence merge race (MEDIUM):** When a user is online on both home and satellite, presence updates from different instances may interleave. A satellite disconnect sets `offline`, then a home heartbeat sets `online`, creating flicker. **Mitigation:** Presence state should be a merge: `online_on_any = online`. Track per-instance presence separately and derive the visible status with `Object.values(instancePresence).some(p => p === 'online')`.

5. **Token refresh overlap (MEDIUM):** Two satellites whose tokens expire at similar times both request `CreateFederationAssertion` near-simultaneously. If assertions are sequential (not parallel), the second may arrive after TTL expiry. **Mitigation:** After meza.chat token refresh, request all satellite assertions in a single `Promise.allSettled()` call. The batch RPC (`CreateFederationAssertions`, plural) from Performance Optimizations would collapse this to 1 RTT.

**From Institutional Learning (WebSocket Gateway Reliability):**
- Reconnect strategy: unlimited attempts with capped exponential backoff (1s→30s), `reconnectCount` field triggers re-fetch on reconnect
- Heartbeat ACK timeout: 45s (1.5× interval) — apply per connection
- Online/offline event listeners: pause reconnect when `navigator.onLine === false`

---

### Phase C: Client — Federation Flows + Satellite UX

Build the user-facing federation features on top of the multi-connection foundation. Split into three sub-phases for clearer milestones.

#### Phase C1: Join/Leave Flows (minimum usable satellite experience)

**Federation Join Flow:**

- [ ] Create `client/packages/core/src/api/federation.ts` (new)
  - `joinSatelliteGuild(inviteUrl)`:
    1. Parse invite URL, detect cross-origin (compare hostname to home server)
    2. Call `ResolveRemoteInvite` on meza.chat → `{instance_url, invite_code}`
    3. Call `CreateFederationAssertion(instance_url)` on meza.chat → assertion JWT
    4. Call `FederationJoin(assertion, invite_code)` on satellite gateway → `{access_token, refresh_token, server, channels, members, user_id}`
    5. Store tokens in instance store
    6. Call `StoreFederatedMembership` on meza.chat (sync for multi-device)
    7. Open WebSocket connection to satellite
    8. Hydrate remaining state: `ListRoles`, `ListChannelGroups`, `ListEmojis` via satellite ConnectRPC
    9. Add guild to sidebar
  - Assertion request must be on-demand (not batched) to avoid 60s TTL expiry on slow satellites
  - Normalize satellite URLs before storage (lowercase hostname, strip trailing slash, enforce HTTPS)

**Federation Leave Flow:**

- [ ] `leaveSatelliteGuild(instanceUrl, serverId)`:
  1. Call `FederationLeave(serverId)` on satellite
  2. Call `RemoveFederatedMembership(instanceUrl, serverId)` on meza.chat
  3. If no other guilds on that satellite: close WebSocket, remove from instance store
  4. Remove guild from sidebar stores
  5. If meza.chat removal fails: retry with backoff (satellite leave is source of truth)

**Join UI:**

- [ ] Invite link detection in `client/packages/ui/`
  - When user pastes/clicks an invite link, check if hostname differs from home server
  - Cross-origin invites trigger a confirmation modal: "Join [guild name] on [satellite URL]?"
  - Modal shows satellite instance name (from `ResolveRemoteInvite` response, or URL if unknown)
  - On confirm: execute `joinSatelliteGuild` flow
- [ ] Loading state during join (assertion request → join → connect → hydrate)

**Profile Push on Connect:**

- [ ] After each satellite WebSocket connect, client calls `UpdateFederatedProfile` on that satellite
  - Sends current `display_name` and `avatar_url` from meza.chat profile
  - Fire-and-forget (don't block connection on profile push)
  - Mid-session profile updates are deferred — profile syncs on next reconnect, which is sufficient (users change profiles rarely)

**Files touched (C1):**
- `client/packages/core/src/api/federation.ts` (new)
- `client/packages/core/src/store/instances.ts` (modify — token storage)
- `client/packages/ui/src/lobby/InviteModal.tsx` (modify or new — cross-origin join confirmation)

**Success criteria (C1):**
- User can join a satellite guild via invite link (full flow: assertion → join → connect → sidebar)
- User can leave a satellite guild (satellite leave + meza.chat membership removal)
- Profile pushed to satellite on connect
- `task test:client` passes

#### Phase C2: Token Lifecycle + Resilience

**Token Refresh Cascade:**

- [ ] Refresh proactively at 75% of TTL (not on expiry)
  - Each connection tracks its own token expiry
  - Home instance token refreshed first (via existing auth flow)
- [ ] Satellite refresh flow:
  1. Request `CreateFederationAssertion(satelliteUrl)` from meza.chat
  2. Call `FederationRefresh(assertion, refreshToken)` on satellite
  3. Store new tokens in instance store
- [ ] Dependency-aware: if meza.chat is unreachable, pause ALL satellite refreshes
  - Remote tokens can't refresh without a fresh assertion from meza.chat
  - Resume satellite refreshes when meza.chat recovers
- [ ] Parallel satellite refresh: after meza.chat refresh succeeds, refresh all satellites concurrently
- [ ] Handle partial failures: one satellite refresh failing does not block others

**Reconnect + Resilience:**

- [ ] On app open / new device:
  1. Authenticate with meza.chat (normal login)
  2. Call `ListFederatedMemberships` on meza.chat → list of (satellite_url, server_id) tuples (source of truth — overwrites localStorage cache)
  3. Connect to meza.chat WebSocket first
  4. For each satellite: request assertion, connect in parallel
  5. Progressive UI: guilds appear in sidebar as each connection succeeds
- [ ] On satellite disconnect:
  - Exponential backoff (1s to 30s cap)
  - Network-aware: pause reconnect when browser is offline
  - On reconnect: re-authenticate (FederationRefresh), re-fetch state (READY)
  - Per institutional learning: use `reconnectCount` field to trigger dependent effects (re-fetch, cache invalidation)
- [ ] On meza.chat recovery: resume satellite reconnects/refreshes

**Ban/Kick Handling:**

- [ ] On `FEDERATION_REMOVED` event from satellite:
  - Close satellite connection
  - Remove guild from stores
  - Remove from instance store
  - Call `RemoveFederatedMembership` on meza.chat
  - Show notification: "You were removed from [guild] on [satellite]"

**Files touched (C2):**
- `client/packages/core/src/store/auth.ts` (modify — multi-instance refresh)
- `client/packages/core/src/store/instances.ts` (modify — token lifecycle)

**Success criteria (C2):**
- Token refresh works across all instances (proactive, dependency-aware)
- New device sign-in discovers and connects to all satellite memberships
- Losing meza.chat connection pauses satellite refreshes; recovery resumes them
- Ban from satellite guild removes it cleanly
- `task test:client` passes

### Research Insights: Phase C Token Lifecycle & Edge Cases

**Token Refresh Cascade — Coordination (Architecture + Security Reviews):**
- Home token MUST refresh before any satellite assertions. If meza.chat is down, all satellite refreshes are blocked (by design — assertions require a valid home token).
- Add a `refreshLock` per instance to prevent concurrent refresh attempts on the same satellite. Use a simple boolean flag + promise dedup pattern: if a refresh is in-flight, return the existing promise.
- On `CodeUnauthenticated` from a satellite RPC (not just token expiry timer): trigger immediate refresh for that specific satellite. This handles clock skew and server-side token revocation.

**Assertion TTL Handling (Security Review):**
- Assertion TTL is 30–60s. The assertion must be consumed within this window. If the satellite's `FederationJoin` or `FederationRefresh` is slow (network latency, cold start), the assertion may expire before the satellite verifies it.
- **Mitigation:** Request the assertion as late as possible — immediately before the satellite call, not batched upfront. For the refresh cascade, request assertions per-satellite just-in-time rather than pre-fetching all at once.
- The batch assertion RPC (`CreateFederationAssertions`) should still work because assertions are consumed within milliseconds of creation. The risk is only with pre-fetching + queuing.

**Ban/Kick Race Conditions (Spec Flow Review):**
- If a user is banned while their client is offline (satellite disconnect), the `FEDERATION_REMOVED` event is lost. On reconnect, the satellite should reject the `FederationRefresh` with `CodePermissionDenied`. The client must handle this as equivalent to `FEDERATION_REMOVED`.
- If a user is kicked but reconnects before the kick propagates, the satellite should check ban status in `FederationRefresh` before issuing new tokens.
- **Wire diagram:** `FederationRefresh` → check `is_banned` on shadow user → if banned, return `CodePermissionDenied` with detail "user_banned" → client interprets as forced removal.

**Membership Sync Consistency (Data Integrity Review):**
- If `FederationLeave` succeeds on the satellite but `RemoveFederatedMembership` fails on meza.chat (network error), the user sees a stale guild in their sidebar on next login. The client should reconcile: attempt to connect to the satellite, which will reject (user removed), then clean up meza.chat's membership record.
- Alternatively: on `ListFederatedMemberships`, for each membership, the client connects to the satellite. If the satellite returns `CodePermissionDenied` or `CodeNotFound`, remove the stale membership from meza.chat. This is "eventual consistency via client-side reconciliation."

#### Phase C3: Satellite UX Polish

- [ ] Per-satellite connection status indicators in sidebar
  - Connected: normal rendering
  - Reconnecting: subtle pulse/spinner on satellite guild icons
  - Offline: greyed-out guild icons, connection error badge
- [ ] Capability-adaptive UI: read `capabilities` from READY payload, hide unavailable features (e.g., file upload when no media, voice channels when no voice)
- [ ] Offline satellite channels: disable message input, show "Satellite offline" banner
  - Cached messages remain visible (read-only)
- [ ] Add optional `instanceUrl` to entity-referencing `PaneContent` variants
  - Default = home instance for backward compatibility

**Files touched (C3):**
- `client/packages/core/src/tiling/types.ts` (modify — instanceUrl on PaneContent)
- `client/packages/ui/src/shell/ServerSidebar.tsx` (modify — instance grouping, status indicators)
- `client/packages/ui/src/shell/ContentArea.tsx` (modify — instance-aware pane routing)
- `client/packages/ui/src/chat/MessageInput.tsx` (modify — disable when satellite offline)
- `client/packages/ui/src/chat/ChannelHeader.tsx` (modify — offline banner)
- `client/packages/web/vite.config.ts` (modify — satellite proxy for dev)

**Success criteria (C3):**
- Capability-adaptive UI hides unavailable features per satellite
- Offline satellites show greyed-out guilds with disabled input
- `task test:client` passes

---

### Phase D: Server — Notification Relay (Post-MVP)

Add server-side push notification relay so satellite guild mentions reach users when offline.

**Relay Token (issued by meza.chat, not the satellite):**

- [ ] Add `CreateRelayToken` RPC to `FederationService` on auth (meza.chat only)
  - Client requests a relay token from meza.chat during the `FederationRefresh` flow
  - meza.chat signs the token with its own Ed25519 key
  - Token claims: `sub` (home_user_id), `aud` (meza.chat relay endpoint), `satellite_url`, `purpose: "notification_relay"`
  - TTL: 7 days (matches satellite refresh token)
  - Client delivers this token to the satellite during `FederationRefresh`
- [ ] Satellite caches relay tokens per federated user
- [ ] On the relay endpoint, meza.chat verifies its own signature — no need to trust satellite-signed tokens (consistent with Decision #3: no satellite registration)

**Relay Endpoint on meza.chat:**

- [ ] Add `RelayNotification` RPC to notification service on meza.chat
  ```protobuf
  rpc RelayNotification(RelayNotificationRequest) returns (RelayNotificationResponse);

  message RelayNotificationRequest {
    string relay_token = 1;
    string channel_id = 2;        // Satellite channel
    string server_name = 3;       // For notification display
    string channel_name = 4;      // For notification display
    NotificationType type = 5;    // mention, reply, etc.
    // No message content (E2EE — satellite can't read it)
  }
  ```
  - Validates relay token signature and claims
  - Looks up user's push subscriptions
  - Sends push notification: "[server_name] #[channel_name]: You were mentioned"
  - Rate limited: 1 relay per 30s per channel per user (matching existing throttle)

**Satellite-Side Forwarding:**

- [ ] Add `MEZA_NOTIFICATION_RELAY_URL` config (e.g., `https://meza.chat`)
- [ ] In satellite's notification consumer (or chat service message handler):
  - On @mention in a message: check if mentioned user is federated (`is_federated = true`)
  - If federated: look up cached relay token for that user
  - Call `RelayNotification` on meza.chat with relay token + notification metadata
  - No message content in payload (E2EE — satellite has ciphertext only)

**Files touched:**
- `proto/meza/v1/notification.proto` (modify — RelayNotification RPC)
- `proto/meza/v1/federation.proto` (modify — CreateRelayToken RPC, relay_token in FederationRefreshRequest)
- `server/cmd/notification/service.go` (modify — relay endpoint)
- `server/cmd/auth/federation_service.go` (modify — CreateRelayToken implementation)
- `server/internal/config/config.go` (modify — relay URL)

**Success criteria:**
- Satellite @mention generates relay call to meza.chat
- meza.chat pushes notification to user's devices
- Relay token expired → relay call rejected, satellite requests new token on next FederationRefresh
- No message content in relay payload
- Rate limiting prevents notification spam

### Research Insights: Phase D Notification Relay Security

**Relay Token Revocation (Security Review):**
- When a user leaves a satellite (`FederationLeave`), the satellite must delete the cached relay token for that user. Otherwise, the satellite retains the ability to send notifications on behalf of a departed user.
- meza.chat should also reject relay calls for users who are no longer members of the originating satellite. This requires checking `federated_memberships` on the relay endpoint (user_id + satellite_url must exist).

**Relay Rate Limiting (Performance Review):**
- The per-channel-per-user rate limit (1 relay/30s) should be enforced on meza.chat's relay endpoint, not trusted from the satellite. A malicious satellite could bypass satellite-side rate limits.
- Add a global per-satellite rate limit as well (e.g., 100 relays/minute per satellite URL) to prevent a compromised satellite from spamming meza.chat's push infrastructure.

**Metadata Minimization (Security Review):**
- The `RelayNotificationRequest` includes `server_name` and `channel_name` for notification display. A malicious satellite could spoof these to show misleading notifications (e.g., "Bank Security Alert"). Consider: (a) prefixing notifications with satellite URL so users know the source, or (b) using the satellite URL stored in `federated_memberships` as the display name instead of trusting satellite-provided strings.

---

## Acceptance Criteria

### Functional Requirements

- [ ] User with meza.chat account can join a guild on a satellite instance via invite link
- [ ] User sees all guilds (meza.chat + satellite) in the sidebar
- [ ] Messages, channels, members, roles work identically on satellite guilds
- [ ] User can leave a satellite guild
- [ ] User can be banned/kicked from a satellite guild
- [ ] DMs always route through meza.chat regardless of where users met
- [ ] New device sign-in restores satellite memberships from meza.chat
- [ ] Profile changes on meza.chat propagate to connected satellites
- [ ] Satellite guilds show capability-adaptive UI (hidden voice/media when unavailable)
- [ ] Satellite guilds show connection status (connected/reconnecting/offline)

### Non-Functional Requirements

- [ ] Federation join completes in < 2 seconds (assertion + join + connect)
- [ ] Client connects to 10 satellites in parallel within 15 seconds
- [ ] One offline satellite does not affect other satellites or DMs
- [ ] Token refresh cascade completes within 5 seconds
- [ ] Satellite capability fingerprinting is impossible without authentication
- [ ] Federated users cannot call identity RPCs on satellites
- [ ] Satellite never receives plaintext message content or identity key bundles

### Quality Gates

- [ ] `task test:server` — all Go tests pass
- [ ] `task test:client` — all Vitest tests pass
- [ ] `task test:e2e:smoke` — smoke tests pass
- [ ] Existing 40+ gateway tests pass after refactor
- [ ] New tests cover: federation join/leave, multi-connection lifecycle, token refresh cascade, satellite offline/reconnect, capability-adaptive UI

## Risk Analysis & Mitigation

| Risk | Impact | Mitigation |
|------|--------|------------|
| Client gateway refactor introduces regressions | High | Incremental 3-step refactor; existing tests preserved at each step |
| Two-level store nesting breaks existing UI components | High | Home instance uses constant key; existing selectors default to home for backward compatibility |
| Token refresh thundering herd on meza.chat | Medium | Per-user rate limit on CreateFederationAssertion (server-side); add client-side jitter only if this becomes a measured problem |
| Satellite operator sees @mention metadata (user IDs) | Medium | Document in threat model; mention IDs are needed for notification relay; E2EE protects message content |
| Membership divergence between meza.chat sync and satellite | Medium | Client retries meza.chat sync with backoff; satellite is source of truth for membership |
| Mobile battery drain from N WebSocket connections | Medium | Single heartbeat coordinator; soft limit of 20 satellite connections |
| JWKS key rotation breaks federation during cache window | Low | JWKS client fetches on unknown kid; key rotation MUST use new kid (documented constraint) |
| E2EE key envelope storage on satellite reduces trust boundary | Low | Envelopes are ciphertext (encrypted to member public keys); satellite cannot decrypt without private keys from meza.chat |

## Explicit Scope

### In Scope

- Embed federation RPCs (Join/Refresh/Leave) in gateway
- Capability advertisement in READY payload
- Profile push on satellite connect
- Client multi-connection architecture (connection manager, heartbeat coordinator)
- Instance-aware Zustand stores (two-level nesting)
- Per-instance API transport with token lifecycle
- Federation join/leave UI flows
- meza.chat membership sync (server-side storage + client read)
- Dependency-aware token refresh cascade
- Satellite UX (connection status, capability-adaptive UI, offline mode)
- E2EE key envelope storage on satellites

### Out of Scope (Future)

- Server-side notification relay from satellites (Phase D — post-MVP)
- Managed satellite hosting / deployment templates
- Self-hosted identity providers (requires WebFinger + configurable JWKS)
- Cross-satellite search
- Satellite admin dashboard / observability
- Guild discovery / directory
- Cross-instance moderation
- Identity migration (moving home server)
- Event replay via sequence numbers
- Symmetric peer-to-peer federation

## Research Insights: Performance & Pattern Consistency

**Performance Patterns (Performance Oracle):**
- **Batch assertion RPC:** Add `CreateFederationAssertions(satellite_urls[])` to auth service. On token refresh, the client sends one request with all satellite URLs instead of N sequential calls. Reduces refresh cascade from N RTTs to 1. Implementation: iterate URLs server-side, sign one assertion per URL, return `map<string, string>` (URL → assertion JWT).
- **Jitter on refresh timers:** Add `Math.random() * 0.1 * TTL` jitter to the 75% TTL refresh trigger. Prevents thundering herd when many users logged in at the same time (e.g., after a deployment). Zero implementation cost.
- **Conditional profile push:** On satellite connect, compare `(display_name, avatar_url)` with the satellite's cached shadow user before writing. SQL: `UPDATE users SET display_name = $2 WHERE id = $1 AND display_name IS DISTINCT FROM $2`. Eliminates write amplification when profile hasn't changed (the common case on reconnect).
- **Shadow-to-home user ID map:** Satellites assign a local `user_id` (shadow) that differs from the meza.chat `home_user_id`. For presence merging, the client needs to correlate them. Use a `Map<shadowUserId, homeUserId>` built from `FederationJoin/Refresh` responses. O(1) lookup vs scanning all instances.
- **Immer proxy overhead:** Two-level `Record<instanceUrl, Record<entityId, T>>` with Immer creates proxy paths proportional to `instances × entities`. For 8 satellites × 20 channels = 160 proxy paths per message store mutation. Consider flat store keys (`${instanceUrl}:${entityId}`) with a selector that filters by prefix. Measure before optimizing — Immer overhead may be negligible for N<20 instances.

**Pattern Consistency (Pattern Recognition Specialist):**
- **READY payload format:** Current READY uses a JSON blob inside a protobuf wrapper. `InstanceCapabilities` is a proper proto message. Decide: (a) add capabilities to the JSON blob for consistency, or (b) migrate READY to a full proto message (breaking change, needs protocol version bump). Recommend (a) for MVP — adding a `capabilities` key to the JSON blob is non-breaking and consistent with current patterns.
- **Gateway file naming:** Existing gateway files are `gateway.go`, `handler.go`, `client.go`. New federation file should be `federation.go` (not `federation_service.go`) to match the flat naming convention. Alternatively, use `federation_handler.go` if it only contains RPC handler methods.
- **NATS subject pattern:** Federation events should follow `meza.federation.{event}.{id}` (e.g., `meza.federation.removed.{serverId}`). This aligns with existing `meza.chat.channel.{channelId}` and `meza.server.member.{serverId}` patterns.

## References

### Internal

- Brainstorm: `docs/brainstorms/2026-03-07-federation-satellites-brainstorm.md`
- Phase 1 plan (Phase A complete): `docs/plans/2026-02-17-feat-federation-phase-1-plan.md`
- Positioning: `docs/plans/2026-03-07-feat-federation-satellites-primary-model-plan.md`
- Federation brainstorm: `docs/brainstorms/2026-02-16-federation-brainstorm.md`
- Encryption architecture: `docs/ENCRYPTION.md`
- Gateway WebSocket: `server/cmd/gateway/gateway.go`
- Federation RPCs: `server/cmd/auth/federation_service.go`
- Federation store: `server/internal/store/federation_store.go`
- JWKS client: `server/internal/federation/jwks_client.go`
- Client gateway: `client/packages/core/src/gateway/gateway.ts`
- Client stores: `client/packages/core/src/store/`
- NATS subjects: `server/internal/subjects/subjects.go`
- Institutional learnings: `docs/solutions/integration-issues/`

### External

- JSON Web Key Set (JWKS): RFC 7517
- Ed25519 in JWTs: RFC 8037
