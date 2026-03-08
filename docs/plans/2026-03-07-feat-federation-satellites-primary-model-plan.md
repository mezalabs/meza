---
title: "feat: Federation Satellites — Primary Federation Model"
type: feat
status: active
date: 2026-03-07
supersedes: docs/plans/2026-02-17-feat-federation-phase-1-plan.md (positioning + product model)
brainstorm: docs/brainstorms/2026-03-07-federation-satellites-brainstorm.md
---

# Federation Satellites — Primary Federation Model

## Overview

Make the **satellite model** the canonical meaning of federation in Meza:

- **meza.chat = identity home server** (login, tokens, keys, DMs)
- **Satellite = community-hosted guild runtime** (guild channels, presence, optional media/voice)
- **Client = connection orchestrator** (home + N satellites)

This keeps user experience simple (one account everywhere) while preserving community control over guild infrastructure.

## Product Positioning (Primary Message)

### Core promise

"Use your Meza account everywhere, including friend-run servers."

This is the same usability mental model as game servers (V Rising/Minecraft):

- Players use one global identity
- Community operators host independent worlds
- Joining is invite-link driven, not account-creation driven

### Explicit non-goals for Phase 1

- No symmetric peer-to-peer federation between full identity providers
- No OIDC/WebFinger mesh
- No claim that meza.chat is fully unaware of satellites (notification relay metadata exists)

## Steelman and Strawman Framing

### Steelman (why this is the right default)

1. **User simplicity wins adoption**
   - One sign-in, one identity, one recovery surface.
2. **Operator simplicity wins supply**
   - Host guild services only; no IdP/OIDC burden.
3. **Security clarity**
   - Credentials and key bundles stay on meza.chat.
   - Satellite handles ciphertext + metadata, not plaintext credentials/keys.
4. **Resilience at social graph level**
   - One satellite outage affects only its guilds, not all guilds.

### Strawman (likely criticisms to address directly)

1. "This is centralized lock-in, not federation."
   - Response: identity is centralized in Phase 1 by design; hosting and operations are decentralized.
2. "Multi-connection clients are fragile."
   - Response: client architecture explicitly includes per-instance reconnection/backoff and capability-aware UI.
3. "You claim meza.chat doesn’t know satellites, but notification relay reveals them."
   - Response: correct; we only claim cryptographic identity verification is open, not metadata invisibility.

## Security Tradeoff Model

## Trust boundaries

| Boundary | meza.chat | Satellite |
|---|---|---|
| Credentials | Trusted | Never receives |
| Key bundles/private keys | Trusted | Never receives |
| Message plaintext | Never sees | Never sees (ciphertext only) |
| Metadata (membership/activity) | Sees some | Sees local guild metadata |

## Security strengths

- Home-server-only identity + key custody
- Audience-scoped federation assertions for remote join/refresh
- Open JWKS verification (no per-satellite shared secret registration)
- E2EE-first message path with client-side encrypt/decrypt

## Security tradeoffs to make explicit in product/docs

1. **Metadata leakage is real**
   - Satellite sees guild metadata.
   - meza.chat sees relay metadata for notifications.
2. **Home server availability dependency**
   - New joins/refresh depend on meza.chat availability.
3. **No forward secrecy in current static-channel-key model**
   - Align messaging with current threat model docs.

## Required guardrails

- Capability-minimized assertion tokens (short TTL, audience-bound, single use)
- SSRF-hardened remote resolution
- Strong federation endpoint rate limits
- Per-satellite health state surfaced in UI
- Conservative notification payload metadata

## Usability Model (Steam-style)

## User flow model

1. User signs into meza.chat once.
2. User opens invite to satellite guild.
3. Client obtains assertion from meza.chat and joins satellite.
4. Guild appears beside home guilds in one sidebar.
5. DMs remain on home server; guild chat stays on satellite.

## UX requirements

- Zero additional account creation on satellites
- Clear per-satellite connection status (connected/reconnecting/offline)
- Graceful degraded mode (cached read-only view when satellite offline)
- Capability-adaptive UI (hide unavailable voice/media features)

## Revenue Model: Managed Satellites

Make managed hosting first-class without changing identity UX.

## Packaging

1. **Self-hosted Satellite (free/open)**
   - Community runs gateway/chat/presence (+ optional media/voice)
2. **Managed Satellite (paid)**
   - Meza-managed deployment, upgrades, backups, monitoring, DDoS baseline
3. **Managed Satellite Plus (paid+)**
   - Higher SLA, moderation tooling bundle, compliance controls, migration support

## Monetization principle

Monetize **operations, reliability, and convenience** — not identity lock-in.

## GTM message

"Host your own Meza community server, or let us host it for you. Your members always use one Meza login."

## Architecture and Scope Decisions

## Canonical terminology

- Use **satellite** as default term in product and docs
- Keep "federation" as protocol umbrella
- Avoid framing that implies full mesh federation in Phase 1

## Service footprint tiers

- **Core tier:** Gateway + Chat + Presence + Postgres + NATS (+ Redis TTL)
- **Addon tier:** Media (S3), Voice (LiveKit)

## Data routing rules

- Guild channels: satellite-local
- DMs + identity + keys: home-server-only
- Notifications: satellite -> meza.chat relay for unified device subscriptions

## Delivery Plan

## Phase A — Positioning and Documentation (immediate)

- Update docs to define satellite model as primary federation model.
- Add explicit security tradeoff language (metadata + availability dependency).
- Add managed hosting packaging and terminology guidance.

## Phase B — Client and Protocol hardening

- Finish multi-connection lifecycle polish (status UX, retry/backoff, capability handling).
- Ensure assertion/refresh flows are dependency-aware and failure-isolated per satellite.
- Add conformance tests for join/refresh/disconnect/offline cases.

## Phase C — Managed hosting launch readiness

- Satellite deployment templates (core vs full-feature)
- Operational SLOs, backup/restore, upgrade policy
- Billing/plan controls and tenant operations runbooks

## Success Metrics

- Federation joins completed in <2s p50
- Satellite reconnect success after outage >99%
- Time-to-first-self-hosted-satellite <30 minutes
- Managed satellite conversion rate from self-hosted trials
- Support tickets per 100 satellites below target threshold

## Risks and Mitigations

1. **Perception risk: "not real federation"**
   - Mitigation: clear identity-centralized / hosting-decentralized positioning.
2. **Operational complexity in client multi-connection**
   - Mitigation: strict connection manager contracts + test matrix.
3. **Metadata sensitivity concerns**
   - Mitigation: documented transparency, payload minimization, optional relay controls (future).

## References

- `docs/brainstorms/2026-03-07-federation-satellites-brainstorm.md`
- `docs/brainstorms/2026-02-16-federation-brainstorm.md`
- `docs/plans/2026-02-17-feat-federation-phase-1-plan.md`
- `docs/ENCRYPTION.md`
- `docs/ARCHITECTURE.md`
