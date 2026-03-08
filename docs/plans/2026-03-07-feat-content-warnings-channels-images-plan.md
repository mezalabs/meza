---
title: "feat: Content Warnings for Channels and Images"
type: feat
status: completed
date: 2026-03-07
---

# feat: Content Warnings for Channels and Images

## Overview

Add a content warning (CW) system to Meza Chat with two complementary mechanisms:

1. **Channel-level CW** — Admins set free-text warnings on channels. Users see an interstitial dialog before entering. Dismissal is in-memory (resets on refresh).
2. **Image-level CW** — Any user can mark their own images as spoilers before sending. Images render blurred with a click-to-reveal overlay.

## Problem Statement / Motivation

Communities need ways to signal sensitive content — NSFW material, spoilers, triggering topics — without banning it outright. Without CW, users stumble into content they didn't consent to see. This is table-stakes for any community chat platform.

## Proposed Solution

### Channel Content Warnings

- Add a `content_warning` text field (max 256 Unicode codepoints, plain text) to the `Channel` model
- Only users with `ManageChannels` permission can set/clear it (channel owners/admins)
- On channel entry, if `content_warning` is non-empty and not dismissed in-session → show a Radix Dialog interstitial with the warning text and a "Continue" button
- CW text is rendered as **plain text only** in the interstitial — never passed through the markdown renderer
- CW text is validated using the same rules as `validateServerName`: reject null bytes, HTML brackets, control characters (including bidi overrides), and whitespace-only strings
- Dismissal state stored in Zustand (in-memory, per-channel, resets on page refresh)
- DM channels are excluded — no admin model, no channel-level CW
- The interstitial is a UX courtesy, not an access control. The server does not enforce acknowledgment

### Image Content Warnings

- Add `bool is_spoiler` as server-side metadata on the `Attachment` model, set via `CompleteUploadRequest` in the Media Service
- `is_spoiler` is **immutable after send** — cannot be toggled via message edit (user must delete and resend)
- All CW data is plaintext server-side (no encrypted CW reason text — channel names/topics are already plaintext, CW metadata is equivalent)
- In the message composer, pending image attachments get a "Mark as spoiler" toggle
- CW images render blurred with a warning overlay; click/tap to reveal
- Reveal state is local React state — re-blurs on remount (consistent with existing `||spoiler||` text behavior)
- CW images in the fullscreen `ImageViewer` are also blurred with tap-to-reveal

## Technical Considerations

### Architecture

- **Proto-first**: All changes start in `.proto` files, then `buf generate` produces Go server stubs and TypeScript client types
- **All plaintext**: Both channel `content_warning` and attachment `is_spoiler` are server-side metadata, consistent with existing unencrypted fields like `filename`, `content_type`, channel `name`, and `topic`. No E2EE integration needed for CW
- **Permissions**: Reuse existing `ManageChannels` permission (bit 5) — no new permission bit needed
- **Real-time**: Channel CW changes broadcast via existing `EVENT_TYPE_CHANNEL_UPDATE` event. No new event type needed
- **Upload lifecycle**: `is_spoiler` is set in `CompleteUploadRequest` — Media Service owns all attachment metadata

### Key Files to Modify

**Proto (source of truth)**:
- `proto/meza/v1/models.proto` — Add `optional string content_warning = 14` to `Channel`, `bool is_spoiler = 11` to `Attachment`
  - `content_warning`: set to empty string to clear, omit to leave unchanged
- `proto/meza/v1/chat.proto` — Add `optional string content_warning = 9` to `UpdateChannelRequest`
- `proto/meza/v1/media.proto` — Add `bool is_spoiler` to `CompleteUploadRequest`

**Server (Go)**:
- `server/internal/models/channel.go` — Add `ContentWarning *string` field
- `server/internal/models/attachment.go` — Add `IsSpoiler bool` field
- `server/internal/store/chat_store.go` — Update channel SQL queries to include `content_warning`
- `server/cmd/chat/service.go` — Update `UpdateChannel`, `channelToProto` handlers; add CW text validation
- `server/cmd/media/service.go` — Update `CompleteUpload` to persist `is_spoiler`
- `server/migrations/` — New migration: add `content_warning TEXT` to `channels`, `is_spoiler BOOLEAN DEFAULT false` to `attachments`

**Client (TypeScript/React)**:
- `client/packages/core/src/api/chat.ts` — Pass CW field in `updateChannel`
- `client/packages/ui/src/components/settings/ChannelOverviewSection.tsx` — Add CW setting field
- `client/packages/ui/src/components/chat/AttachmentRenderer.tsx` — Blur CW images with overlay
- `client/packages/ui/src/components/chat/ImageViewer.tsx` — Handle CW state in fullscreen
- `client/packages/ui/src/components/chat/MessageComposer.tsx` — Add "Mark as spoiler" toggle on pending files
- New component: `ContentWarningInterstitial.tsx` — Radix Dialog for channel CW gate
- `client/packages/ui/src/components/chat/ChannelView.tsx` or `ContentArea.tsx` — Gate channel content behind CW interstitial

### Existing Patterns to Reuse

- **Spoiler text** (`remarkMezaSpoiler.ts`, `SpoilerText` in `MarkdownRenderer.tsx`) — Click-to-reveal with local React state, CSS `color: transparent` toggle. Image CW should follow this UX pattern
- **Micro-thumbnail blur** (`AttachmentRenderer.tsx`) — Already uses `blur-xl scale-110` for loading placeholders. CW blur can reuse this visual treatment
- **Radix Dialog** (`CreateChannelDialog`, `DeleteMessageDialog`, `BanMemberDialog`) — Consistent modal pattern with `Dialog.Root`/`Portal`/`Overlay`/`Content`
- **Toggle switch** (`CreateChannelDialog.tsx` line 177-193) — `sr-only` checkbox with peer-checked styling
- **Input validation** (`validateServerName` at `service.go:40-54`) — Reuse or generalize for CW text validation

### Performance

- Channel CW check is a simple string-empty check on already-loaded channel data — zero overhead
- Image blur uses CSS `filter: blur()` on already-rendered thumbnails — GPU-accelerated, negligible cost
- No new API calls needed for CW checks (data comes with existing channel/message payloads)

### Security

- `is_spoiler` boolean metadata is equivalent to existing `filename`/`content_type` exposure — acceptable
- CW text on channels is plaintext like `name`/`topic` — consistent with existing model
- `ManageChannels` permission gate prevents unauthorized CW modifications
- Max 256 Unicode codepoints on CW text prevents abuse
- CW text validated: no null bytes, HTML brackets, control/bidi characters, or whitespace-only
- CW text rendered as plain text only — never through markdown renderer (prevents XSS)
- `is_spoiler` is immutable after send — prevents post-hoc abuse

## Acceptance Criteria

### Channel Content Warnings

- [x] Admin can set a free-text content warning (max 256 codepoints) when editing a channel
- [x] Admin can clear a content warning by emptying the field
- [x] CW text is validated (null bytes, HTML, control chars, whitespace-only rejected)
- [x] Users entering a CW channel see an interstitial dialog with the warning text (plain text, not markdown) and a "Continue" button
- [x] After dismissing, the interstitial does not reappear until page refresh (in-memory, per-channel)
- [x] DM channels cannot have content warnings (field excluded from UI and API validation)
- [x] Real-time: if admin adds CW while user is in channel, interstitial appears on next entry (not retroactively)
- [x] Proto `optional string content_warning` distinguishes "not set" (no change) from "empty string" (clear)

### Image Content Warnings

- [x] In the message composer, pending image attachments have a "Mark as spoiler" toggle
- [x] `is_spoiler` flag set via `CompleteUploadRequest` in Media Service
- [x] `is_spoiler` is immutable after message is sent
- [x] CW images render blurred with a warning label overlay in chat
- [x] Clicking/tapping the overlay reveals the image
- [x] Revealed images re-blur when scrolled out of view and back (consistent with spoiler text)
- [x] CW images in the fullscreen `ImageViewer` are blurred with tap-to-reveal

### Testing

- [ ] Permission checks: non-admin cannot set channel CW
- [ ] CW text validation rejects invalid input
- [ ] Interstitial appears/dismisses correctly across channel navigation
- [ ] Image CW toggle works in composer and flag is persisted
- [ ] Blur/reveal behavior matches existing spoiler text pattern
- [ ] Accessibility: interstitial has proper ARIA attributes (`role="alertdialog"`, `aria-describedby`), images have screen-reader labels, keyboard-navigable reveal

## Dependencies & Risks

**Dependencies:**
- Proto schema changes must land first (all other work depends on generated types)
- `buf generate` must run after proto changes to produce Go and TypeScript types

**Risks:**
- **Virtualization re-blur**: List virtualization unmounts images on scroll, resetting reveal state. This is consistent with spoiler text behavior but may surprise users for large images that take time to decrypt. Acceptable for MVP, can be revisited with a session-scoped reveal cache if needed
- **Gateway event handling gotcha**: Per documented learnings, new event-related fields must be handled in the gateway client's discriminated union dispatcher — ensure `channel_update` with CW changes is properly handled (though no new event type is needed, the CW field in the Channel payload needs to flow through)

## Deferred (Post-MVP)

These items were identified during review and explicitly deferred:

- **Global CW opt-out user preference** — Cut for MVP. Users can click through interstitials per-session. Add if users request it.
- **Sidebar CW badge/indicator** — The interstitial serves this purpose. Add if users request visual hints.
- **Link preview/embed image blurring** — Over-protective in already-warned channels. Defer.
- **Push notification suppression** — E2EE already prevents content previews in notifications (generic "You have a new message"). No work needed.
- **Audit log entries for CW changes** — Current `UpdateChannel` handler has no audit logging. Add audit logging for all channel updates as a separate task, not special-cased for CW.
- **CW rate limiting** — Defer to general channel metadata rate limiting task.
- **CW at channel creation time** — Support only via `UpdateChannel` for MVP (one code path). Trivial to add to `CreateChannelRequest` later.

## References & Research

### Internal References

- Channel model: `server/internal/models/channel.go`
- Attachment model: `server/internal/models/attachment.go`
- Channel proto: `proto/meza/v1/models.proto:48-62`
- Attachment proto: `proto/meza/v1/models.proto:125-136`
- Channel handlers: `server/cmd/chat/service.go:726` (create), `:1764` (update)
- Media service: `proto/meza/v1/media.proto` (CompleteUploadRequest)
- Input validation: `server/cmd/chat/service.go:40-54` (validateServerName)
- Spoiler text: `client/packages/ui/src/components/shared/remarkMezaSpoiler.ts`
- Spoiler reveal: `client/packages/ui/src/components/chat/MarkdownRenderer.tsx:326-334`
- Image rendering: `client/packages/ui/src/components/chat/AttachmentRenderer.tsx`
- Image viewer: `client/packages/ui/src/components/chat/ImageViewer.tsx`
- Permissions: `server/internal/permissions/permissions.go`
- Migration pattern: `server/migrations/`
- Notification service: `server/cmd/notification/service.go:547-667` (already generic, no CW work needed)

### Documented Learnings

- Gateway event handler gotcha: `docs/solutions/integration-issues/websocket-gateway-reliability-and-reconnection.md` — ensure new proto fields are handled in gateway dispatch, use `else if` chains for discriminated unions
- NATS event wiring: `docs/solutions/integration-issues/audit-nats-events-subscription-and-serialization-fixes.md` — all payloads use `proto.Marshal`/`proto.Unmarshal`, never JSON
