---
title: "feat: Bot Developer Management UX"
type: feat
status: completed
date: 2026-03-22
brainstorm: docs/brainstorms/2026-03-22-bot-developer-management-brainstorm.md
---

# feat: Bot Developer Management UX

## Enhancement Summary

**Deepened on:** 2026-03-22
**Sections enhanced:** 5 phases + architecture decisions + acceptance criteria
**Analysis sources:** SpecFlow analyzer (32 gaps, 12 critical questions), repo-research-analyst (full codebase pattern map), learnings-researcher, security/architecture/performance/data-integrity/pattern/simplicity review agents

### Key Improvements (from SpecFlow + Research)
1. **Separated incoming/outgoing webhook models** (AD1) — fundamental data model fix
2. **Bot invite page uses InviteLanding pattern** (AD2) — works for unauthenticated users outside pane system
3. **Added invite expiration/revocation** (AD5) — security: leaked links expire after 7 days
4. **Header-only webhook auth** (AD4) — query params leak in logs
5. **Added 6 missing RPCs** — ListBotInvites, DeleteBotInvite, CreateIncomingWebhook, DeleteIncomingWebhook, ListIncomingWebhooks, UpdateBot with field mask
6. **WCAG compliance** — token modal uses confirmation step instead of keyboard trap, BOT badge has aria-label
7. **Rate limiting spec** — 30 msg/min per incoming webhook with 429 response
8. **DB schema hardened** — UNIQUE constraint on incoming_webhooks(bot_user_id, channel_id), indexes, secret hash storage

### Research Insights

**Webhook Design (Discord/Slack patterns):**
- Incoming webhooks should be channel-bound (not server-wide) — matches Discord's model
- Webhook secrets should use HMAC or hash comparison, never stored in plaintext
- Rate limiting is essential — Discord uses 5/5s per webhook, Slack uses tiered rate limits
- Webhook URLs should include an opaque ID (not bot_id + channel_id) to prevent enumeration

**Bot Invite UX (Discord model):**
- Discord uses OAuth2 URLs with permission bitmask in query params — we use invite codes instead (simpler for V1)
- Permission display should use human-readable names with descriptions, not raw bitfield names
- Server selector should only show servers where user has ManageBots permission
- Post-accept should offer navigation to the server

**Token Display Security:**
- Show-once pattern is industry standard (GitHub PATs, Discord bot tokens, Slack webhooks)
- Copy button with visual confirmation ("Copied!") reduces user anxiety
- Acknowledgment gate prevents accidental dismissal without saving credentials

**Zustand Store Design:**
- User's bots → dedicated `useBotStore` (CRUD for owned bots)
- Server's bots → filter from existing `useMemberStore` where `isBot === true` (no new store needed)
- This avoids data duplication and stays consistent with how other member-based views work

**BOT Badge Accessibility:**
- `role="img"` with `aria-label="Bot"` for screen readers
- Sufficient color contrast (WCAG AA: 4.5:1 ratio minimum)
- Badge should be announced in message context: "[BotName] (bot) said: ..."

## Overview

Build an in-app bot management experience within the Meza web UI serving three audiences: third-party bot developers, server admins, and no-code/Zapier/n8n users. Adds "My Bots" to user settings, "Bots" to server settings, bot invite links with profile preview pages, and incoming webhooks for bidirectional no-code integration.

## Problem Statement

The bot backend is built (10 RPCs, token auth, webhook delivery) but there is no way for anyone to use it without making raw ConnectRPC calls. Bot developers need a UI to create and manage bots, server admins need a UI to add and configure bots, and no-code users need incoming webhooks to post messages from external tools.

## Technical Approach

### Architecture

The feature is primarily frontend (React components + Zustand stores) with backend additions:

1. **Bot invite links** — new proto messages + RPCs for generating/resolving bot-specific invite codes
2. **Incoming webhooks** — new model (separate from outgoing webhooks) with channel binding + HTTP endpoint
3. **UpdateBot RPC** — allow bot owners to edit profile (description, avatar, display_name)

```
Bot Developer                    Server Admin
     │                                │
     ▼                                ▼
┌──────────────┐              ┌──────────────┐
│ User Settings│              │Server Settings│
│  "My Bots"   │              │   "Bots"      │
│  - Create    │              │  - Add via    │
│  - Edit      │  invite link │    invite     │
│  - Tokens    │─────────────▶│  - Remove     │
│  - Invites   │              │  - Webhooks   │
└──────────────┘              └──────────────┘
                                     │
                              ┌──────┴──────┐
                              │  Incoming    │
                              │  Webhooks    │
                              │  POST→msg    │
                              └─────────────┘
```

### Key Architectural Decisions

**AD1: Incoming webhooks are a separate model from outgoing webhooks.**
The existing `Webhook`/`BotWebhook` model is for outgoing delivery (Meza pushes events TO an external URL). Incoming webhooks (external tools POST TO Meza) need a `channel_id`, their own secret, and a different URL scheme. New `IncomingWebhook` proto message, `incoming_webhooks` DB table, and dedicated RPCs.

**AD2: Bot invite page uses the InviteLanding pattern, not a pane.**
Meza uses a tiling pane system (`PaneContent` union), not React Router. Bot invite pages must work for unauthenticated users who cannot access the pane system. Following the existing `InviteLanding.tsx` pattern: URL parsed in `main.tsx`, stored in an invite store, rendered as a standalone public page outside the authenticated shell.

**AD3: `AcceptBotInvite` delegates to existing `AddBotToServer` internally.**
The `AcceptBotInvite` RPC resolves the invite code, validates the admin's ManageBots permission, then delegates to the existing `AddBotToServer` logic (ban checks, membership checks, event publishing). Requested permissions are informational — the bot joins as a regular member and the admin assigns roles afterwards.

**AD4: Incoming webhook auth uses headers only, not query params.**
Query params appear in access logs, browser history, CDN logs, and Referer headers. Incoming webhooks authenticate via `X-Webhook-Secret` header.

**AD5: Bot invites have expiration and revocation.**
Invite codes expire after 7 days by default. Bot owners can list and delete invites. Prevents leaked links from remaining valid forever.

### Implementation Phases

#### Phase 1: Backend — Bot Invites + Incoming Webhooks + UpdateBot

New proto definitions and RPCs for bot invite links, incoming webhooks (separate model), and bot profile editing.

**Tasks:**

- [x] Add `description` field (field 7) to `Bot` proto message in `proto/meza/v1/models.proto`
- [x] Add `bot_description` column to `users` table: `ALTER TABLE users ADD COLUMN bot_description TEXT`
- [x] Update Go `User` model in `server/internal/models/user.go` with `BotDescription` field
- [x] Update `botToProto()` in `server/cmd/chat/service_bot.go` to map description
- [x] Add `BotInvite` message to `proto/meza/v1/models.proto`:
  ```protobuf
  message BotInvite {
    string code = 1;
    string bot_id = 2;
    int64 requested_permissions = 3;
    string creator_id = 4;
    google.protobuf.Timestamp created_at = 5;
    google.protobuf.Timestamp expires_at = 6;
  }
  ```
- [x] Add `IncomingWebhook` message to `proto/meza/v1/models.proto`:
  ```protobuf
  message IncomingWebhook {
    string id = 1;
    string bot_user_id = 2;
    string server_id = 3;
    string channel_id = 4;
    string secret = 5;          // shown once at creation
    string creator_id = 6;
    google.protobuf.Timestamp created_at = 7;
  }
  ```
- [x] Add bot invite RPCs to `proto/meza/v1/chat.proto`:
  ```protobuf
  rpc CreateBotInvite(CreateBotInviteRequest) returns (CreateBotInviteResponse);
  rpc ResolveBotInvite(ResolveBotInviteRequest) returns (ResolveBotInviteResponse);  // public, no auth
  rpc AcceptBotInvite(AcceptBotInviteRequest) returns (AcceptBotInviteResponse);
  rpc ListBotInvites(ListBotInvitesRequest) returns (ListBotInvitesResponse);
  rpc DeleteBotInvite(DeleteBotInviteRequest) returns (DeleteBotInviteResponse);
  ```
- [x] Add incoming webhook RPCs to `proto/meza/v1/chat.proto`:
  ```protobuf
  rpc CreateIncomingWebhook(CreateIncomingWebhookRequest) returns (CreateIncomingWebhookResponse);
  rpc DeleteIncomingWebhook(DeleteIncomingWebhookRequest) returns (DeleteIncomingWebhookResponse);
  rpc ListIncomingWebhooks(ListIncomingWebhooksRequest) returns (ListIncomingWebhooksResponse);
  ```
- [x] Add `UpdateBot` RPC with field mask support:
  ```protobuf
  rpc UpdateBot(UpdateBotRequest) returns (UpdateBotResponse);
  // UpdateBotRequest has google.protobuf.FieldMask update_mask
  ```
- [x] Define all request/response messages for new RPCs
- [x] Create database migration for `bot_invites` table:
  ```sql
  CREATE TABLE bot_invites (
    code TEXT PRIMARY KEY,
    bot_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    requested_permissions BIGINT NOT NULL DEFAULT 0,
    creator_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + INTERVAL '7 days'
  );
  CREATE INDEX idx_bot_invites_bot_id ON bot_invites(bot_id);
  ```
- [x] Create database migration for `incoming_webhooks` table:
  ```sql
  CREATE TABLE incoming_webhooks (
    id TEXT PRIMARY KEY,
    bot_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    secret_hash TEXT NOT NULL,
    creator_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(bot_user_id, channel_id)
  );
  ```
- [x] Implement bot invite RPCs in `server/cmd/chat/service_bot.go`:
  - `CreateBotInvite`: owner generates code (crypto-random, 128-bit entropy), specifies permissions, max 10 active invites per bot
  - `ResolveBotInvite`: public RPC, returns bot profile (name, avatar, description, owner username) + requested permissions. No sensitive data (no owner email, no server list)
  - `AcceptBotInvite`: validates ManageBots permission, checks expiry, delegates to AddBotToServer logic internally
  - `ListBotInvites`: owner lists active (non-expired) invites for a bot
  - `DeleteBotInvite`: owner revokes an invite code
- [x] Implement `UpdateBot` RPC: owner can update display_name, description, avatar_url using field mask for partial updates
- [x] Implement incoming webhook RPCs in `server/cmd/chat/service_bot.go`:
  - `CreateIncomingWebhook`: requires ManageWebhooks permission, bot must be server member, returns secret once
  - `DeleteIncomingWebhook`: requires ManageWebhooks or bot owner
  - `ListIncomingWebhooks`: requires ManageWebhooks on server
- [x] Add incoming webhook HTTP endpoint to webhook service (`POST /webhook/incoming/:id`):
  - Validate secret via `X-Webhook-Secret` header (hash comparison, not plaintext storage)
  - Accept JSON body `{"content": "message text"}` (max 4000 chars)
  - Rate limit: 30 messages/minute per webhook, return 429 when exceeded
  - Create message with `KeyVersion=0`, `AuthorID=bot_user_id`, `MessageType=DEFAULT`
  - Publish to NATS `meza.deliver.channel.<channelID>`
  - Return 200 on success, 400 for validation errors, 401 for bad secret, 404 for unknown webhook, 429 for rate limit
- [x] Add `ResolveBotInvite` to `PUBLIC_METHODS` in client transport (no auth required, like `ResolveInvite`)
- [x] Run `buf generate` to regenerate clients
- [x] Add store methods for bot invites (create, get by code, list by bot, delete, cleanup expired)
- [x] Add store methods for incoming webhooks (create, get by id, list by server, delete)

**Success criteria:**
- Bot invite link can be created, listed, resolved, accepted, and revoked
- Server admin can accept a bot invite and the bot joins the server
- Incoming webhook endpoint accepts POST with header auth and creates a message in the bound channel
- Rate limiting returns 429 when exceeded
- UpdateBot allows partial profile updates

---

#### Phase 2: Frontend — "My Bots" in User Settings

Add bot management section to user settings.

**Tasks:**

- [x] Add Zustand store for bots in `client/packages/core/src/store/bots.ts`:
  - State: `bots: Bot[]`, `loading: boolean`, `error: string | null`
  - Actions: `fetchBots()`, `createBot()`, `deleteBot()`, `regenerateToken()`, `updateBot()`
  - Follow immer pattern from `members.ts`
- [x] Add API client methods in `client/packages/core/src/api/bots.ts` (new file):
  - `createBot()`, `deleteBot()`, `regenerateBotToken()`, `listBots()`, `getBot()`, `updateBot()`
  - `createBotInvite()`, `resolveBotInvite()`, `acceptBotInvite()`, `listBotInvites()`, `deleteBotInvite()`
  - `createIncomingWebhook()`, `deleteIncomingWebhook()`, `listIncomingWebhooks()`
- [x] Export new store and API from `client/packages/core/src/index.ts`
- [x] Add `{id: 'bots', label: 'My Bots'}` to `SETTINGS_SECTIONS` in `SettingsView.tsx` (line 18)
- [x] Add case `'bots': return <BotsSection />` to `renderSettingsContent()` switch in `SettingsView.tsx`
- [x] Create `client/packages/ui/src/components/settings/BotsSection.tsx`:
  - Wraps in `<div className="max-w-md space-y-6">` (follows AccountSection pattern)
  - Section header: `<h2 className="text-xs font-semibold uppercase tracking-wider text-text-subtle">My Bots</h2>`
  - List of user's bots with name, avatar, description, creation date
  - "Create Bot" button → opens CreateBotDialog
  - Per-bot actions: Edit, Regenerate Token, Generate Invite Link, Delete
  - Empty state: explanation of what bots are + "Create your first bot" CTA
  - Loading state with skeleton
- [x] Create `client/packages/ui/src/components/settings/CreateBotDialog.tsx`:
  - Radix Dialog following InviteDialog pattern
  - Form: username (validated: `^[a-zA-Z0-9_]{2,32}$`), display name
  - On submit: calls `createBot()`, shows BotTokenModal on success
  - Error handling: username taken, max bots reached (25)
- [x] Create `client/packages/ui/src/components/settings/BotTokenModal.tsx`:
  - Displays token and private key with copy buttons
  - Warning: "Save these now — they won't be shown again"
  - "I've saved my credentials" checkbox + "Done" button (button disabled until checked)
  - Escape key and overlay click show confirmation ("Are you sure? Credentials cannot be retrieved later.") rather than being completely disabled (WCAG 2.1 keyboard trap compliance)
- [x] Create `client/packages/ui/src/components/settings/EditBotDialog.tsx`:
  - Edit display name, description, avatar (upload via media service)
  - Uses `UpdateBot` with field mask — only sends changed fields
- [x] Create `client/packages/ui/src/components/settings/BotInviteDialog.tsx`:
  - Permission selector: checkboxes with human-readable labels (e.g., "Send Messages" not "SEND_MESSAGES"), descriptions from `permissions.ts` metadata
  - Warning when Administrator permission is selected
  - Generate invite link → display with copy button
  - Shows the invite URL: `https://<instance>/bot-invite/<code>`
  - Shows list of existing active invites with delete buttons

**Success criteria:**
- Users can create, edit, and delete bots from settings
- Token modal shows credentials once with copy buttons and confirmation gate (not keyboard trap)
- Bot invite links can be generated with requested permissions, listed, and revoked

---

#### Phase 3: Frontend — Bot Invite Accept Page

Public page shown when someone clicks a bot invite link. Follows the existing `InviteLanding.tsx` pattern for unauthenticated access.

**Tasks:**

- [x] Add URL parsing for `/bot-invite/:code` in `client/packages/web/src/main.tsx` (alongside existing `/invite/:code` parsing, ~line 39-49)
- [x] Add `botInviteCode` field to invite store (or create a dedicated `useBotInviteStore`)
- [x] Create `client/packages/ui/src/components/lobby/BotInviteLanding.tsx`:
  - Rendered outside the authenticated Shell, same level as `InviteLanding.tsx`
  - Calls `resolveBotInvite(code)` on mount to load bot profile (public, no auth)
  - Displays: bot avatar, name, description, owner username
  - Lists requested permissions in human-readable form using permission metadata from `permissions.ts`
  - **Unauthenticated state**: shows bot profile + "Log in to add this bot" button, stores invite code in `sessionStorage` before redirecting to login
  - **Authenticated state**: server selector dropdown (shows servers where user has ManageBots permission), "Add to Server" button → calls `acceptBotInvite(code, serverId)`
  - **Success state**: "Bot added to [server name]!" with link to open server
  - **Error states**: expired invite, bot deleted, bot already in server, no ManageBots permission on any server
- [x] Handle post-login redirect: check `sessionStorage` for pending bot invite code on app load, restore bot invite page if found
- [x] Add rendering logic in `main.tsx` or app root to show `BotInviteLanding` when bot invite code is present (before Shell loads)

**Success criteria:**
- Clicking a bot invite link shows the bot profile and requested permissions (works without auth)
- After logging in, user is returned to the bot invite page
- Server admin can select a server and add the bot
- Appropriate error handling for expired/deleted/duplicate cases

---

#### Phase 4: Frontend — Server Settings "Bots" Section

Add bot management to server settings.

**Tasks:**

- [x] Add `{id: 'bots', label: 'Bots'}` to `SERVER_SETTINGS_SECTIONS` in `ServerSettingsView.tsx` (line 13)
- [x] Add case to `renderServerSettingsContent()` switch in `ServerSettingsView.tsx` (line 122)
- [x] Create `client/packages/ui/src/components/settings/ServerBotsSection.tsx`:
  - Lists bots in the server by filtering `useMemberStore` members where `isBot === true` (NOT the bot store — that's for "My Bots")
  - Per-bot: avatar, name, description, joined date
  - "Remove Bot" button with confirmation dialog (uses KickMemberDialog pattern)
  - "Manage Webhooks" expandable per bot
  - Empty state: "No bots in this server. Add one with a bot invite link."
  - "Paste Invite Link" input to add a bot directly from server settings
- [x] Create `client/packages/ui/src/components/settings/OutgoingWebhookManagement.tsx`:
  - List outgoing webhooks for this server (from `listWebhooks` RPC)
  - "Create Webhook" form (select bot from server members, enter destination URL)
  - Secret display modal (shown once, copy button — reuse BotTokenModal pattern)
  - "Delete Webhook" button with confirmation
- [x] Create `client/packages/ui/src/components/settings/IncomingWebhookManagement.tsx`:
  - List incoming webhooks for this server (from `listIncomingWebhooks` RPC)
  - "Create Incoming Webhook" form (select bot from server members, select channel)
  - Shows the incoming webhook URL: `https://<instance>/webhook/incoming/<id>`
  - Copy button for the URL
  - Test button (sends a POST with a test message)
  - "Delete" button with confirmation
  - Plaintext warning: "Messages received via incoming webhooks are not end-to-end encrypted"

**Success criteria:**
- Server admins can view and remove bots from server settings
- Outgoing and incoming webhooks have separate, clear management sections
- Incoming webhook URLs are displayed with copy functionality
- Test button successfully sends a message

---

#### Phase 5: Frontend — BOT Badge + Visual Indicators

Make bots visually distinguishable throughout the UI.

**Tasks:**

- [x] Create `client/packages/ui/src/components/common/BotBadge.tsx`:
  - Small "BOT" pill badge: `<span role="img" aria-label="Bot" className="ml-1 inline-flex items-center rounded bg-accent/20 px-1 py-0.5 text-[10px] font-semibold uppercase leading-none text-accent">BOT</span>`
  - Exported from `client/packages/ui/src/index.ts`
- [x] Add BOT badge to message author display in `MessageHeader.tsx` (check `author.isBot`)
- [x] Add BOT badge to member list items in `MemberList.tsx` (check `member.isBot`)
- [x] Add BOT badge to `ProfilePopoverCard.tsx` (check `user.isBot`)
- [x] Add separate "Bots" section in member list sidebar (below roles, above offline):
  - Filter members where `isBot === true`
  - Section header: "BOTS — N" (matching existing role section header style)
- [x] Add visual indicator on channels that have incoming webhooks:
  - Small info banner at top of channel: "This channel has incoming webhooks. Messages from webhooks are not encrypted."

**Success criteria:**
- Bots are clearly identifiable with "BOT" badges everywhere they appear
- BOT badge is accessible to screen readers (`aria-label="Bot"`)
- Member list has a dedicated "Bots" section
- Channels with incoming webhooks show a plaintext warning

---

## Acceptance Criteria

### Functional Requirements

- [x] Bot developers can create, edit, and delete bots from user settings
- [x] Bot tokens are displayed in a secure modal with copy buttons and confirmation gate
- [x] Bot invite links can be generated with requested permissions, listed, and revoked
- [x] Bot invite page shows bot profile and permissions before adding (works unauthenticated)
- [x] Server admins can add bots via invite links (from bot invite page or server settings)
- [x] Server admins can manage bots, outgoing webhooks, and incoming webhooks from server settings
- [x] Incoming webhooks can receive POST requests and create plaintext messages (header auth, rate limited)
- [x] Bots display accessible "BOT" badge in messages, member list, and profile cards
- [x] All existing bot backend tests continue to pass

### Non-Functional Requirements

- [x] Invite page loads in < 2s (single RPC call)
- [x] Token modal prevents accidental closure without being a keyboard trap
- [x] Incoming webhook endpoint responds in < 500ms
- [x] Incoming webhook rate limited to 30 msg/min per webhook
- [x] Bot invite codes use 128-bit crypto-random entropy

## Dependencies & Prerequisites

- Bot backend RPCs (already implemented in current branch)
- Media service for bot avatar uploads (already exists)
- Existing settings/modal UI patterns
- InviteLanding.tsx pattern for public bot invite page

## Scope Boundaries

### Explicitly Out of Scope

- Bot marketplace / discovery directory
- Bot SDK (Go/TypeScript/Python)
- CLI tooling for bot management
- OAuth2 bot installation flow
- Bot analytics / usage dashboards
- Slash commands / interaction components
- Audit logging for bot management actions (future enhancement)

## References

### Internal References

- Brainstorm: `docs/brainstorms/2026-03-22-bot-developer-management-brainstorm.md`
- Bot backend plan: `docs/plans/2026-03-21-feat-add-bot-support-plan.md`
- Settings pattern: `client/packages/ui/src/components/settings/SettingsView.tsx`
- Server settings pattern: `client/packages/ui/src/components/settings/ServerSettingsView.tsx`
- Invite landing pattern: `client/packages/ui/src/components/lobby/InviteLanding.tsx`
- Invite dialog pattern: `client/packages/ui/src/components/shell/InviteDialog.tsx`
- Zustand store pattern: `client/packages/core/src/store/members.ts`
- API client pattern: `client/packages/core/src/api/chat.ts`
- Public methods: `client/packages/core/src/api/client.ts` (line 12)
- Pane system: `client/packages/core/src/tiling/types.ts`
- Content rendering: `client/packages/ui/src/components/shell/ContentArea.tsx`
- URL parsing: `client/packages/web/src/main.tsx` (lines 39-49)
- Permission metadata: `client/packages/core/src/store/permissions.ts` (lines 255-303)
- Bot RPCs: `server/cmd/chat/service_bot.go`
- Bot store: `server/internal/store/bot_store.go`
- Proto definitions: `proto/meza/v1/chat.proto`, `proto/meza/v1/models.proto`
- User model: `server/internal/models/user.go`
