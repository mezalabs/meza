# Meza Security Audit Report

**Date:** 2026-03-09
**Scope:** Full repository — server (Go), client (TypeScript), cryptography, infrastructure, deployment
**Branch:** `app-pentest-5` at commit `43a07ca`

---

## Executive Summary

Meza demonstrates strong security engineering fundamentals: Ed25519 JWT signing with algorithm pinning, Argon2id password hashing with constant-time comparison, parameterized SQL queries throughout, SSRF protection with post-DNS-resolution IP blocking, a comprehensive anti-enumeration strategy, sign-then-encrypt E2EE with ECIES key wrapping, and a dedicated security test suite (`server/security/`). The codebase shows clear security awareness from its developers.

This audit identified **0 CRITICAL**, **8 HIGH**, **16 MEDIUM**, **14 LOW**, and **8 INFO**-level findings across 6 analysis domains. The highest-impact issues center on configuration defaults that fail open (WebSocket CORS wildcard, weak HMAC secret), missing server-side input bounds (unbounded message size, no AuthKey length limit), a federation refresh token replay vulnerability, and client-side key material exposure.

No findings enable trivial remote code execution or authentication bypass.

---

## Findings by Severity

### CRITICAL — None

---

### HIGH

#### H-1: Federation Refresh Token Not Consumed (Replayable)

| | |
|---|---|
| **Domain** | Authentication |
| **File** | `server/cmd/auth/federation_service.go:339-416` |
| **Impact** | A stolen federation refresh token can be replayed indefinitely within its 30-day validity window |

The `FederationRefresh` endpoint validates the local refresh token JWT but never calls `ConsumeRefreshToken` to atomically delete/rotate it in the database. Compare with the regular `RefreshToken` endpoint (`service.go:296-310`) which correctly calls `s.store.ConsumeRefreshToken()`. Federation refresh tokens are therefore multi-use, defeating refresh token rotation.

**Remediation:** Add `ConsumeRefreshToken` and `StoreRefreshToken` calls to `FederationRefresh`, mirroring the pattern in the regular `RefreshToken` handler.

---

#### H-2: No Logout / Token Revocation Endpoint

| | |
|---|---|
| **Domain** | Authentication |
| **File** | `server/cmd/auth/service.go` (missing RPC) |
| **Impact** | Users cannot invalidate their sessions; access tokens remain valid for up to 1 hour after compromise |

There is no `Logout` RPC. `RevokeDevice` deletes the device record and blocks the device ID, but there is no lightweight way for a user to simply end their session. The access token remains valid until expiry (1 hour).

**Remediation:** Implement a `Logout` RPC that deletes refresh tokens for the current device and adds the device ID to the token blocklist for 1 hour (matching access token TTL).

---

#### H-3: HMAC Secret Not Validated at Startup

| | |
|---|---|
| **Domain** | Configuration |
| **Files** | `server/internal/config/config.go:19`, `server/cmd/auth/main.go:56`, `.env.example:13`, `deploy/docker/docker-compose.yml:137` |
| **Impact** | Anti-enumeration protections defeated if the default `dev-secret-change-in-production` value reaches production |

The `HMACSecret` config field has no `required` tag and no validation. An empty or default-value secret allows attackers to precompute fake salts/recovery bundles for any identifier, distinguishing real users from non-existent ones. The `docker-compose.yml` hardcodes the `.env.example` default.

**Remediation:** Add a startup check that rejects empty, short (<32 bytes), or known-placeholder values like `dev-secret-change-in-production`.

---

#### H-4: WebSocket Origin Defaults to Wildcard

| | |
|---|---|
| **Domain** | Gateway |
| **File** | `server/cmd/gateway/gateway.go:98, 117-134` |
| **Impact** | Cross-Site WebSocket Hijacking in any production deployment that forgets to set `ALLOWED_ORIGINS` |

`parseAllowedOrigins` defaults to `["*"]` when the env var is unset. This variable is not in `.env.example`, not in `config.go`, and not in `docker-compose.yml`. Any deployment following the example config will silently accept WebSocket connections from any origin.

**Remediation:** Move `ALLOWED_ORIGINS` into `config.go`, add to `.env.example` and `docker-compose.yml`, and fail to start if unset (or log a prominent warning).

---

#### H-5: SendMessage Has No Server-Side Content Size Limit

| | |
|---|---|
| **Domain** | Input Validation |
| **File** | `server/cmd/chat/service.go` (SendMessage handler) |
| **Impact** | DoS via database bloat and memory exhaustion — 10MB+ messages accepted via direct ConnectRPC calls |

The gateway enforces a 64KB WebSocket message limit, but direct ConnectRPC calls to the chat service (port 8082) bypass the gateway. The security test `TestSendMessageNoSizeLimit` confirms 1MB and 10MB messages are accepted.

**Remediation:** Add `maxContentSize = 65536` validation in `SendMessage` and reject messages exceeding it.

---

#### H-6: No Per-Connection Message Rate Limiting on WebSocket

| | |
|---|---|
| **Domain** | Gateway |
| **File** | `server/cmd/gateway/gateway.go:796-877` (`readPump`) |
| **Impact** | Authenticated clients can flood heartbeats, typing events, or messages with no throttle, amplifying through NATS/ConnectRPC |

IP-based rate limiting applies only to the HTTP upgrade. Once connected, `readPump` processes messages as fast as they arrive. A malicious client can flood typing events, heartbeats, or `SEND_MESSAGE` ops to overwhelm downstream services.

**Remediation:** Add a per-connection token bucket (e.g., 30 msgs/s burst 10). Specifically throttle `TYPING_START` to 1 per 3 seconds per channel server-side.

---

#### H-7: Master Key Stored in Plaintext localStorage

| | |
|---|---|
| **Domain** | Cryptography |
| **File** | `client/packages/core/src/crypto/session.ts:43-58` |
| **Impact** | XSS anywhere in the application exposes the master key, which decrypts the user's E2EE identity keypair |

The 32-byte Argon2id-derived master key is base64-encoded in `localStorage` under `meza-mk`. Combined with the encrypted key bundle in IndexedDB, XSS yields full identity compromise.

**Remediation:** Use Web Crypto API non-extractable `CryptoKey` objects where possible. On mobile (Capacitor), use iOS Keychain / Android Keystore. Consider encrypting the localStorage entry with a session-scoped key.

---

#### H-8: AES-GCM Key Cache Exposes Raw Key Material as JavaScript String

| | |
|---|---|
| **Domain** | Cryptography |
| **File** | `client/packages/core/src/crypto/primitives.ts:273-303` |
| **Impact** | Channel keys persist as immutable hex strings in the JS heap, extractable via heap snapshots or memory dumps |

`channelKeyCacheKey()` converts raw 32-byte channel keys to hex strings for use as `Map` keys. JavaScript strings cannot be reliably zeroized and persist in memory indefinitely.

**Remediation:** Use `SHA-256(rawKey)` or `HMAC(constant, rawKey)` as the cache key so the map key cannot be reversed to the original key material.

---

### MEDIUM

#### M-1: No Device Revocation Check on WebSocket Authentication

| | |
|---|---|
| **Domain** | Gateway |
| **File** | `server/cmd/gateway/gateway.go:565-615` |

The ConnectRPC interceptor checks the `TokenBlocklist`, but the gateway's `authenticateFirstMessage` does not. A revoked device can maintain a WebSocket connection and receive real-time events until the access token expires.

**Remediation:** Add `TokenBlocklist` checking to `authenticateFirstMessage`, or subscribe to revocation events via NATS and force-close affected connections.

---

#### M-2: Verification Cache TTL Mismatch in Gateway

| | |
|---|---|
| **Domain** | Gateway |
| **File** | `server/cmd/gateway/gateway.go:611` |

The gateway caches JWT claims with a hardcoded 1-hour TTL instead of using `claims.ExpiresAt`. If a token has <1 hour remaining, the cache entry outlives the token, allowing expired tokens to pass authentication.

**Remediation:** Use `claims.ExpiresAt` as the cache expiry: `gw.verificationCache.Put(token, claims, claims.ExpiresAt)`.

---

#### M-3: JWT Token Accepted via URL Query Parameter

| | |
|---|---|
| **Domain** | Authentication |
| **File** | `server/internal/auth/http_middleware.go:46-54` |

Tokens in URLs are logged by servers/proxies, cached in browser history, and leaked via Referer headers. The HTTP middleware also does not check the token blocklist (unlike the Connect interceptor).

**Remediation:** Issue short-lived, single-use, scope-limited tokens for media access rather than reusing full JWTs. Add blocklist checking to `RequireHTTPAuth`.

---

#### M-4: Rate Limiter Ignores Proxy Headers

| | |
|---|---|
| **Domain** | Infrastructure |
| **File** | `server/internal/ratelimit/ratelimit.go:64-68` |

Uses `r.RemoteAddr` directly. Behind a reverse proxy, all clients share one rate-limit bucket. An attacker bypassing the proxy faces no rate limiting at all.

**Remediation:** Support `X-Forwarded-For` / `X-Real-IP` parsing when a trusted proxy list is configured.

---

#### M-5: No Maximum Length Validation on AuthKey

| | |
|---|---|
| **Domain** | Input Validation |
| **File** | `server/cmd/auth/service.go:97, 178, 667` |

`AuthKey` is checked for non-empty but has no upper bound. Since it's passed to Argon2id, a multi-MB payload causes excessive CPU/memory consumption (DoS).

**Remediation:** Add `len(r.AuthKey) > 128` rejection (the client-derived key should never exceed this).

---

#### M-6: NATS Connection Has No Authentication

| | |
|---|---|
| **Domain** | Infrastructure |
| **File** | `server/internal/nats/client.go:35` |

Any process that can reach the NATS server can subscribe to all subjects and publish arbitrary events. The gateway forwards NATS messages directly to WebSocket clients, so a rogue publisher could inject fake messages into any channel.

**Remediation:** Enable NATS authentication (token, nkey, or TLS client certs). Use NATS authorization to restrict per-service publish/subscribe.

---

#### M-7: NATS Subject Injection via Unsanitized IDs

| | |
|---|---|
| **Domain** | Gateway |
| **File** | `server/internal/subjects/subjects.go` (all functions) |

NATS subjects are built via `fmt.Sprintf` with user/channel/device IDs. NATS uses `.` as separator and `>` / `*` as wildcards. If any ID contains these characters, subject semantics change.

**Remediation:** Validate all IDs used in subject construction contain only alphanumeric characters and hyphens. Add a sanitization function in the `subjects` package.

---

#### M-8: Connected Devices Redis Set Has No TTL

| | |
|---|---|
| **Domain** | Notifications |
| **File** | `server/cmd/notification/service.go:162-175` |

If a gateway pod crashes without sending disconnect events, device entries persist forever in Redis. The notification service skips push for "online" devices — stale entries permanently suppress push notifications.

**Remediation:** Set a TTL on entries refreshed via the heartbeat cycle, or use sorted sets with timestamps and periodic pruning.

---

#### M-9: LiveKit Token Validity Period Excessive (24 Hours)

| | |
|---|---|
| **Domain** | Voice |
| **File** | `server/cmd/voice/service.go:231` |

A user who receives a LiveKit token can use it for 24 hours even after being removed from the server/channel, since LiveKit validates the token independently.

**Remediation:** Reduce to 1-2 hours. Proactively call `RemoveParticipant` when members are removed/banned.

---

#### M-10: No AES-GCM Additional Authenticated Data (AAD) Binding

| | |
|---|---|
| **Domain** | Cryptography |
| **Files** | `client/packages/core/src/crypto/primitives.ts:317-334`, `keys.ts:76-94`, `file-encryption.ts:50-66` |

All AES-256-GCM operations use empty `additionalData`. Without AAD binding, a malicious server could swap ciphertexts between channels sharing the same key version, and decryption would succeed.

**Remediation:** Pass `channelId || keyVersion` as AAD for messages, `channelId || attachmentId` for file key wrapping.

---

#### M-11: ValidateURL is a No-Op Stub

| | |
|---|---|
| **Domain** | Input Validation / SSRF |
| **File** | `server/internal/embed/safeclient.go:97-104` |

`ValidateURL` only checks `len(rawURL) < 8`. It doesn't verify scheme, reject non-standard ports, or block dangerous protocols. While `ExtractURLs` enforces scheme/port and the dial-time SSRF check blocks private IPs, the initial request URL is not port-validated — `https://internal-service:8443/` would connect.

**Remediation:** Add scheme (http/https only) and port (80/443 only) validation to `FetchHTML` before the initial request.

---

#### M-12: GetPinnedMessages Missing Channel Access Check

| | |
|---|---|
| **Domain** | Authorization |
| **File** | `server/cmd/chat/service_pins.go:167-182` |

Checks server membership but not `requireChannelAccess`. A server member who is not a member of a private channel could retrieve its pinned messages.

**Remediation:** Add `requireChannelAccess` call after the membership check.

---

#### M-13: ListInvites Has No Permission Check

| | |
|---|---|
| **Domain** | Authorization |
| **File** | `server/cmd/chat/service.go:2695-2722` |

Any server member can list all invites (codes, creators, use counts, encrypted channel keys). Unlike `CreateInvite` (requires `CreateInvite` permission) and `ListBans` (requires `BanMembers`).

**Remediation:** Add `ManageServer` permission check, or filter results to only show invites the caller created.

---

#### M-14: CreateServer Has No Name Validation

| | |
|---|---|
| **Domain** | Input Validation |
| **File** | `server/cmd/chat/service.go` (CreateServer handler) |

`UpdateServer` validates name (non-empty, max 100 runes), but `CreateServer` accepts empty names, 10,000+ character names, and names with HTML/null bytes. Confirmed by `TestServerNameNoValidation` in the security test suite.

**Remediation:** Apply the same validation as `UpdateServer` (lines 2280-2288).

---

#### M-15: No Dependency Security Scanning in CI

| | |
|---|---|
| **Domain** | Supply Chain |
| **File** | `.github/workflows/ci.yml` |

CI runs `go vet`, `go test -race`, and linting, but no vulnerability scanning. The project has 160+ transitive Go dependencies and a large pnpm lockfile.

**Remediation:** Add `govulncheck ./...` to the server CI job and `pnpm audit --audit-level=high` to the client CI job.

---

#### M-16: Postgres `sslmode=disable` in All Connection Strings

| | |
|---|---|
| **Domain** | Infrastructure |
| **Files** | `.env.example:22`, `deploy/docker/docker-compose.yml` (all service entries) |

All database connections are unencrypted. In production with a separate database host, credentials and queries are exposed in transit.

**Remediation:** Document that production must use `sslmode=require` or `sslmode=verify-full`. Consider a startup warning when `sslmode=disable` is detected.

---

### LOW

#### L-1: Recovery Rate Limit TOCTOU (Redis INCR + EXPIRE)
`server/cmd/auth/service.go:48-65` — Separate `INCR` and `EXPIRE` calls. If `EXPIRE` fails, the key persists forever, permanently rate-limiting that email. Calling `EXPIRE` on every request creates a sliding window. **Fix:** Use a Lua script or `SET NX EX` pattern.

#### L-2: Token Blocklist Fails Open on Redis Error
`server/internal/auth/token_blocklist.go:33-36` — `IsDeviceBlocked` returns `false` on Redis errors. Revoked devices operate freely during Redis outages. **Fix:** Consider fail-closed behavior or at minimum log the error prominently.

#### L-3: Anti-Enumeration Timing Side Channel on GetSalt
`server/cmd/auth/service.go:236-256` — Database query latency for real users differs from HMAC computation for fake salts. **Fix:** Always compute both the fake salt and perform the DB query.

#### L-4: Email Address Logged as PII in Rate Limit Errors
`server/cmd/auth/service.go:55,59` and `server/internal/email/noop.go:16` — Raw email addresses in log entries. **Fix:** Log hashed or truncated form.

#### L-5: No `aud` (Audience) Claim in Access/Refresh Tokens
`server/internal/auth/jwt.go:132-169` — Without `aud`, tokens are fungible across all services sharing the same Ed25519 key. **Fix:** Add `aud` claims and validate in the interceptor.

#### L-6: Federation JTI Replay Protection Disabled Without Redis
`server/cmd/auth/federation_service.go:40-42` — `consumeJTI` returns `true` unconditionally when Redis is nil. **Fix:** Return an error instead of silently disabling replay protection.

#### L-7: Invite Secret Stored in sessionStorage
`client/packages/core/src/store/invite.ts:20-30` — 32-byte invite secret accessible via XSS. **Fix:** Process invite bundles immediately and clear from sessionStorage.

#### L-8: No Key Material Zeroization
`client/packages/core/src/crypto/` (all files) — No `buffer.fill(0)` calls on sensitive key material (Argon2id output, DH shared secrets, ephemeral keys). **Fix:** Add `zeroize(buf)` utility and apply to all sensitive buffers.

#### L-9: Heartbeat ACK Blocks Without Backpressure Check
`server/cmd/gateway/gateway.go:818` — `client.Send <- ack` blocks if buffer is full, stalling `readPump` indefinitely. **Fix:** Use `select`/`default` with slow consumer close.

#### L-10: Media Access Permission Cache Has No Invalidation
`server/internal/store/media_access_store.go:32-68` — In-memory `sync.Map` cache with 5-minute TTL is not invalidated when permissions change. **Fix:** Reduce TTL or integrate with Redis-based invalidation.

#### L-11: GetReactions Fails for DM Channels
`server/cmd/chat/service_reactions.go:211-216` — Uses `requireMembership(ch.ServerID)` which fails for DMs where `ServerID` is empty. **Fix:** Use `GetChannelAndCheckMembership` like `AddReaction`/`RemoveReaction`.

#### L-12: Dynamic WHERE Clause Pattern (Safe but Fragile)
`server/internal/store/auth_store.go:204,218,247,253` — `whereClause string` parameter concatenated into SQL. Currently all callers pass hardcoded literals, but future misuse creates injection risk. **Fix:** Use explicit methods per query variant.

#### L-13: Metrics Endpoint Exposed Without Authentication
`server/cmd/*/main.go` (all services) — `/metrics` reveals internal request counts, latency, error rates. **Fix:** Serve on a separate internal-only port or add authentication.

#### L-14: Unbounded Channel Key Cache Growth
`client/packages/core/src/crypto/channel-keys.ts:33, 166-191` — `channelKeyCache` Map grows without limit across channels. **Fix:** Add LRU eviction (e.g., 500 most recently used channels).

---

### INFO

#### I-1: Recovery Phrase PBKDF2 Uses Static Salt
`client/packages/core/src/crypto/recovery.ts:21-22` — Static `"meza-recovery"` salt. Low impact given BIP39 128-bit entropy.

#### I-2: HKDF Zero-Salt in Multiple Derivations
`client/packages/core/src/crypto/keys.ts:12`, `invite-keys.ts:13`, `recovery.ts:89` — Acceptable per RFC 5869 when input is high-entropy.

#### I-3: No Forward Secrecy (Acknowledged Design Decision)
Static channel key model — documented in THREATMODEL.md and code comments.

#### I-4: GetPublicKeys Allows Any User to Query Any Key
`server/cmd/keys/service.go:165-189` — Intentional for E2EE. Documented in IDOR test.

#### I-5: GetProfile Returns Full Profile Without Shared Context
`server/cmd/auth/service.go:473-501` — Intentional for DM initiation. `dm_privacy` correctly stripped for non-self.

#### I-6: 6-Digit Verification Code Has ~20-bit Collision Space
`client/packages/core/src/crypto/device-recovery.ts:38-46` — Acceptable for visual confirmation UX.

#### I-7: Docker Images Pinned to Major Version, Not Digest
`deploy/docker/Dockerfile*` — Minor supply chain risk. Acceptable for open-source project.

#### I-8: Incomplete X25519 Low-Order Point List
`client/packages/core/src/crypto/primitives.ts:116-122` — 5 of ~7 known points listed. **Fix:** Verify against complete set or validate DH output is non-zero.

---

## Positive Security Observations

The following patterns demonstrate mature security engineering:

1. **JWT Algorithm Pinning** — `jwt.WithValidMethods([]string{"EdDSA"})` prevents algorithm confusion attacks
2. **Refresh Token Rotation** — Single-use via `ConsumeRefreshToken` with atomic delete-before-issue
3. **Anti-Enumeration** — Deterministic fake salts/recovery bundles using HMAC for unknown users
4. **Constant-Time Comparison** — `subtle.ConstantTimeCompare` for password hashes, `hmac.Equal` for recovery verifiers
5. **SSRF Protection** — Post-DNS-resolution IP blocking via `syscall.RawConn` Control callback (prevents DNS rebinding)
6. **Parameterized Queries** — All SQL uses pgx `$1` placeholders throughout. No string concatenation of user input.
7. **XSS Prevention** — `rehype-sanitize` with restrictive schema, no unsafe innerHTML patterns, images in markdown converted to links
8. **In-Process Image Processing** — `govips` via C FFI, no shell execution (`exec.Command`) found anywhere
9. **Role Hierarchy Enforcement** — All moderation operations enforce `callerPos > targetPos` with owner protection
10. **Anti-Escalation** — Permission mutations check that callers cannot grant permissions they don't possess
11. **ECIES Key Wrapping** — Ephemeral keys, proper HKDF with context binding (ephemeral_pub || recipient_pub)
12. **Domain Separation** — Distinct HKDF info strings per protocol context (`meza-key-wrap-v1`, `meza-device-recovery-v1`, etc.)
13. **Sign-Then-Encrypt** — Messages include Ed25519 sender signature inside the AES-GCM ciphertext
14. **X25519 Low-Order Point Rejection** — Protects against key substitution attacks
15. **First-Write-Only Public Keys** — Registration prevents key replacement
16. **Gateway Identity Enforcement** — Typing events override `userId` with authenticated identity
17. **Decompression Bomb Protection** — 16384px max image dimension
18. **OTP Hash Storage** — SHA-256 hashed before Redis storage
19. **Comprehensive Security Test Suite** — Dedicated `server/security/` package with IDOR, auth, permissions, headers, and gateway tests
20. **Threat Model Documentation** — Clear `THREATMODEL.md` with explicit trust assumptions

---

## Remediation Roadmap

### Immediate (Before Release)

| # | Finding | Effort |
|---|---------|--------|
| H-1 | Add `ConsumeRefreshToken` to `FederationRefresh` | Small |
| H-3 | Validate HMAC secret at startup (reject empty/default) | Small |
| H-4 | Require explicit `ALLOWED_ORIGINS`; add to config/docs | Small |
| H-5 | Add `maxContentSize` check in `SendMessage` | Small |
| H-6 | Add per-connection rate limiter in `readPump` | Medium |
| M-2 | Fix gateway verification cache TTL to use `claims.ExpiresAt` | Small |
| M-5 | Add `len(AuthKey) > 128` check | Small |
| M-12 | Add `requireChannelAccess` to `GetPinnedMessages` | Small |
| M-14 | Add name validation to `CreateServer` | Small |
| L-9 | Non-blocking heartbeat ACK send | Small |
| L-11 | Fix `GetReactions` DM handling | Small |

### Short-Term (Next Sprint)

| # | Finding | Effort |
|---|---------|--------|
| H-2 | Implement `Logout` RPC | Medium |
| M-1 | Add device blocklist to gateway authentication | Medium |
| M-3 | Implement scoped media-access tokens | Medium |
| M-4 | Add trusted-proxy config for rate limiter | Medium |
| M-8 | Add TTL to connected-devices Redis entries | Small |
| M-9 | Reduce LiveKit token validity to 1-2 hours | Small |
| M-11 | Add scheme/port validation to `FetchHTML` initial request | Small |
| M-13 | Add permission check to `ListInvites` | Small |
| M-15 | Add `govulncheck` and `pnpm audit` to CI | Small |
| L-4 | Redact PII from log entries | Small |

### Medium-Term (Next Quarter)

| # | Finding | Effort |
|---|---------|--------|
| H-7 | Protect master key with Web Crypto API non-extractable keys | Large |
| H-8 | Hash channel keys for cache lookup instead of hex encoding | Medium |
| M-6 | Enable NATS authentication | Medium |
| M-7 | Add NATS subject ID sanitization | Small |
| M-10 | Add AAD binding to AES-GCM operations | Medium |
| M-16 | Document and warn on `sslmode=disable` | Small |
| L-8 | Add key material zeroization utility | Medium |
| L-10 | Integrate media permission cache with Redis invalidation | Medium |
| L-14 | Add LRU eviction to channel key cache | Medium |

### Backlog

All remaining LOW and INFO findings.

---

## Methodology

This audit was performed via static analysis of the complete source tree using 6 parallel analysis passes:

1. **Authentication & Session Management** — JWT, password hashing, rate limiting, federation auth, token lifecycle
2. **Authorization & IDOR** — Access control on all 15+ service handlers, permission system, store layer, existing security tests
3. **Cryptography & E2EE** — Client-side crypto primitives, key management, nonce handling, key storage, recovery mechanisms
4. **Input Validation & Injection** — SQL injection, XSS, SSRF, file upload, WebSocket message validation, command injection
5. **Infrastructure & Secrets** — Config, deployment, CI/CD, dependencies, Docker, logging, error handling
6. **Gateway & Real-time** — WebSocket, voice/WebRTC, presence, notifications, NATS, Redis

Each finding was validated against the source code with file and line references. Findings that appeared in multiple analysis passes were deduplicated and consolidated.
