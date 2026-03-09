# Client Implementation Guide

## Overview

The Meza client is a TypeScript monorepo that produces three build targets from
shared source code:

1. **Web** — Browser-only SPA served via Vite. No install required.
2. **Desktop** — Minimal Electron stub. Full desktop features (native notifications, tray icon, auto-update) are planned.
3. **Core** — Headless library for third-party integrations (bots, CLI tools).

---

## UI Architecture: Pane-First Tiling

The Meza client uses an **i3/sway-inspired tiling window manager** as its primary UI model.
There is no router — the tiling system replaces traditional page navigation.

**Core principle:** Every view is a pane. Chats, settings, profiles, search, voice — all render
as tiling panes that can be split horizontally/vertically, resized, focused, and closed.

The canonical list of pane types lives in the `PaneContent` union in
`packages/core/src/tiling/types.ts`:

- `channel` — Text channel view (messages, composer, member list)
- `dm` — Direct message conversation
- `voice` — Voice channel panel
- `screenShare` — Screen share viewer (with participant identity)
- `settings` — User settings (with optional section)
- `serverSettings` — Server-specific settings
- `profile` — User profile view
- `search` — Search interface
- `serverOnboarding` — Server welcome/rules/onboarding flow
- `getStarted` — New user get started view
- `createServer` — Server creation wizard
- `messageRequests` — DM message requests list
- `friends` — Friends list (with optional tab field)
- `channelSettings` — Channel-specific settings (with serverId and channelId)
- `empty` — Placeholder pane

To add a new view:

1. Add a variant to `PaneContent` (e.g. `{ type: 'myview'; someId: string }`)
2. Handle it in `paneLabel`, `paneIcon`, and `renderPaneContent` in `ContentArea.tsx`
3. Create the view component (outer wrapper must use `flex flex-1 min-h-0 min-w-0`)
4. Add a navigation trigger (sidebar button, keyboard shortcut, or context menu)

**Modals are reserved for transient confirmations and dialogs** (e.g. "Are you sure?" prompts).
New features should default to pane content types, not modals or separate pages.

---

## Monorepo Structure

```
client/
├── packages/
│   ├── core/                       # Platform-agnostic logic
│   │   └── src/
│   │       ├── api/                # ConnectRPC client wrappers (one per service)
│   │       ├── crypto/             # E2EE: key derivation, channel keys, message encrypt/decrypt
│   │       ├── gateway/            # WebSocket gateway client (binary protobuf, auto-reconnect)
│   │       ├── push/               # Web Push notification manager
│   │       ├── store/              # Zustand state management (~26 stores)
│   │       ├── tiling/             # i3-style tiling window manager
│   │       └── search/             # Full-text search
│   ├── ui/                         # React component library
│   │   └── src/
│   │       ├── components/         # chat/, lobby/, profile/, settings/, shell/, voice/, onboarding/
│   │       ├── hooks/              # useChannelEncryption, useVoiceConnection, etc.
│   │       └── stores/             # UI-specific stores (tiling, navigation, image viewer)
│   ├── web/                        # Browser build target (Vite)
│   └── desktop/                    # Electron shell
└── gen/                            # Auto-generated ConnectRPC TypeScript (do not edit)
```

---

## Package Manager and Tooling

| Tool | Purpose |
|------|---------|
| pnpm | Package manager (workspace support, disk efficient) |
| Vite | Dev server + production bundler for web target |
| Electron | Desktop shell |
| electron-builder | Desktop packaging and auto-update |
| Vitest | Unit testing (Vite-native, fast) |
| Playwright | E2E testing |
| Biome | Linting and formatting (single tool, fast) |

**Note:** The project uses Tailwind CSS v4 with OKLCH color tokens defined in `@theme` blocks.

Key scripts: `pnpm dev` (web dev server), `pnpm dev:desktop` (Electron), `pnpm build`, `pnpm test`, `pnpm lint`, `pnpm codegen`.

---

## State Management

Use Zustand for global state. It is lightweight, TypeScript-native, and avoids
the boilerplate of Redux while supporting middleware (persistence, devtools).

### Store Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                          Zustand Stores                              │
├──────────┬──────────┬───────────┬───────────┬────────────────────────┤
│ authStore│ msgStore │ chanStore │serverStore│ + 22 more stores       │
│          │          │           │           │                        │
│ token    │ messages │ channels  │ servers   │ dms, members, roles,   │
│ user     │ by chan  │ by server │ list      │ presence, typing,      │
│          │          │           │           │ reactions, pins,       │
│          │          │           │           │ emojis, sounds, voice, │
│          │          │           │           │ permissions, invite,   │
│          │          │           │           │ users, read-state,     │
│          │          │           │           │ friends, blocks,       │
│          │          │           │           │ audioSettings, gateway │
└────┬─────┴────┬─────┴─────┬─────┴─────┬─────┴──────────┬────────────┘
     │          │           │           │                │
     └──────────┴───────────┴───────────┴────────────────┘
                            │
              ┌─────────────┼─────────────┐
              │             │             │
    ┌─────────▼──────┐ ┌───▼─────────┐ ┌─▼───────────────┐
    │ ConnectRPC API │ │   Gateway   │ │  Push Manager   │
    │ (8 services)   │ │ (WebSocket) │ │ (Web Push)      │
    └────────────────┘ └─────────────┘ └─────────────────┘
```

### Store Pattern

Each store follows the same pattern — a `create<State>()` call with state + action functions. Stores are indexed by domain entity (e.g., messages indexed by channel ID). Gateway events dispatch directly into stores, triggering React re-renders.

```typescript
// Example: creating a typed Zustand store
export const useMessageStore = create<MessageState>((set) => ({
  byChannel: {},
  addMessage: (channelId, message) => set((state) => ({ ... })),
}));
```

---

## WebSocket Gateway Client

The gateway WebSocket client is implemented in `packages/core/src/gateway/gateway.ts`. It uses a binary Protobuf protocol over WebSocket with the following features:

- **Protocol:** Binary Protobuf-encoded `GatewayEnvelope` frames
- **Opcodes:** IDENTIFY, READY, HEARTBEAT, HEARTBEAT_ACK, EVENT, SEND_MESSAGE, TYPING_START, RESUME
- **Connection flow:** WebSocket connect → IDENTIFY with JWT → receive READY (user data, servers, channels) → begin heartbeat loop
- **Auto-reconnect:** Exponential backoff with jitter, configurable max attempts
- **Event dispatch:** Incoming events are decoded and dispatched to the appropriate Zustand stores (messages, presence, typing, channels, members, voice state)
- **Resumption:** On reconnect, sends RESUME with session ID and last sequence number to replay missed events

### Gateway Provider (React)

The gateway connection is managed by the UI layer and integrates with the Zustand stores. Events from the gateway update stores directly, which causes React components to re-render.

---

## Push Notifications

The client supports Web Push notifications for background delivery when the tab is not active.

- **`packages/core/src/push/push-manager.ts`** — Manages the push subscription lifecycle: registers the service worker, requests notification permission, subscribes to Web Push via VAPID key from the server, and sends the subscription to the backend via `RegisterDevice`
- **`packages/web/public/sw-push.js`** — Service worker that receives push events (metadata only, E2EE-compatible), displays native notifications, and handles click-to-navigate

The push system is E2EE-compatible: push payloads contain only metadata (channel name, sender name), never message content. The actual message is fetched and decrypted when the user opens the app.

---

## Voice and Screen Share Components

Voice is fully implemented using LiveKit:

- **`VoicePanel.tsx`** — Main voice UI, renders LiveKit room with participant list and controls
- **`VoiceConnectionBar.tsx`** — Persistent bar showing active voice connection status
- **`PersistentVoiceConnection.tsx`** — Maintains voice connection across pane navigation
- **`ScreenSharePane.tsx`** — Dedicated pane for viewing screen shares
- **`SoundboardPanel.tsx`** — Soundboard UI for playing sounds in voice channels

The voice store (`packages/core/src/store/voice.ts`) tracks connection state (connecting, connected, reconnecting), the active channel, and LiveKit credentials.

---

## ConnectRPC Client Setup

The API client uses `@connectrpc/connect-web` with a shared transport that auto-attaches the JWT from the auth store. Each service gets its own typed client instance (e.g., `authClient`, `chatClient`).

```typescript
// High-level usage
const res = await authClient.login({ email, password });
const messages = await chatClient.getMessages({ channelId, limit: 50 });
```

---

## Electron Desktop Shell

The desktop build is currently a minimal stub that loads the web app in a BrowserWindow with `contextIsolation: true`.

> **[Planned]** Full desktop features including native notifications, system tray, auto-update, preload/context bridge, and deep linking are planned but not yet implemented.

---

## Browser-Only Mode Considerations

The browser build has no Electron APIs.

Platform detection (`isElectron()`, `getBaseUrl()`) is implemented in `packages/core/src/utils/platform.ts`.

### Browser Limitations and Workarounds

| Limitation | Workaround |
|-----------|------------|
| IndexedDB can be cleared | Server-side encrypted key backup (see ENCRYPTION.md) |
| No background execution | Service Worker for push notifications |
| Tab suspension | Reconnect on visibility change |
| No system tray | Favicon badge counter |
| 64KB WebSocket frame limit | Chunking for large payloads |

### Tab Visibility Handling

The gateway client listens for `visibilitychange` events and automatically reconnects when a suspended tab becomes visible again.

---

## Development Workflow

```bash
# Install dependencies
pnpm install

# Start web dev server (hot reload)
pnpm dev

# Start desktop dev (Electron + Vite)
pnpm dev:desktop

# Run all tests
pnpm test

# Lint and format
pnpm lint

# Build for production
pnpm build
```

---

## Accessibility

- All interactive elements must be keyboard navigable
- Use semantic HTML (`<nav>`, `<main>`, `<article>`, `<button>`)
- ARIA labels on icon-only buttons
- Focus management: trap focus in modals, return focus on close
- Respect `prefers-reduced-motion` for animations
- Respect `prefers-color-scheme` for default theme
- Screen reader announcements for new messages (aria-live region)
