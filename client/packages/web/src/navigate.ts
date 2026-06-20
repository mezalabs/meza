import {
  isSessionReady,
  type PendingPushNav,
  setPendingPushNav,
  useAuthStore,
} from '@meza/core';
import { useTilingStore } from '@meza/ui';

/** Navigate the focused pane to a server-channel view. */
export function navigateToChannel(channelId: string): void {
  const store = useTilingStore.getState();
  store.setPaneContent(store.focusedPaneId, {
    type: 'channel',
    channelId,
  });
}

/** Navigate the focused pane to a DM (1:1 or group) conversation. */
export function navigateToDMConversation(conversationId: string): void {
  const store = useTilingStore.getState();
  store.setPaneContent(store.focusedPaneId, {
    type: 'dm',
    conversationId,
  });
}

/**
 * Shape of the navigation data carried by every push notification entry
 * point — Capacitor tap, web service worker postMessage, Electron deep-link
 * URL, and the cold-window URL fallback. `kind` is the client-side name for
 * the server's `pushPayload.Type` value (`"dm" | "message" | "mention"`); the
 * wire decode happens at each entry-point boundary.
 */
export type PushNavigationData = PendingPushNav;

function dispatch(data: PushNavigationData): void {
  if (data.kind === 'dm') {
    navigateToDMConversation(data.channel_id);
  } else {
    navigateToChannel(data.channel_id);
  }
}

/**
 * Single dispatch helper used by all four push entry points (Capacitor,
 * Web SW, Electron, and the cold-start launch path).
 *
 * Routing: `kind === 'dm'` → DM pane; anything else → channel pane.
 *
 * Security guarantee — strict deny:
 *   1. The payload MUST carry both `channel_id` and `user_id`. The server
 *      always emits these post-T-57; missing values mean either an old
 *      payload (drop — DM panes were already broken for those clients) or
 *      a forged/stripped payload (drop).
 *   2. The current session's user.id MUST equal `data.user_id` once known.
 *      A mismatch is dropped immediately (cross-account leak prevention).
 *
 * Cold-start handling: if the auth store has not yet hydrated a user.id
 * (the launch tap fires before bootstrap), buffer the intent in
 * `pending-push-nav` and let the App's drain useEffect replay it once
 * `sessionReady && isAuthenticated`. The drain calls back into this
 * function, so the user_id check still runs — just with `currentUserId`
 * defined the second time around.
 *
 * `setPaneContent` with identical args is intentionally idempotent;
 * multi-tap does not need a dedupe map.
 */
export function navigateFromPush(data: PushNavigationData): void {
  if (!data.channel_id || !data.user_id) return;

  const auth = useAuthStore.getState();
  if (!auth.isAuthenticated) return; // logged out → drop, do not buffer.

  const currentUserId = auth.user?.id;
  if (currentUserId && currentUserId !== data.user_id) return;

  // Auth hydrated but session not yet ready, or user.id not yet exposed:
  // buffer and drain in the App's useEffect once both flip true.
  if (!isSessionReady() || !currentUserId) {
    setPendingPushNav(data);
    return;
  }

  dispatch(data);
}
