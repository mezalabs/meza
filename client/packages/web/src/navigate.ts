import { useAuthStore } from '@meza/core';
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
export interface PushNavigationData {
  kind?: string;
  channel_id?: string;
  user_id?: string;
}

/**
 * Single dispatch helper used by all four push entry points (Capacitor,
 * Web SW, Electron, and the cold-start launch path).
 *
 * Security guarantee — strict deny:
 *   1. The payload MUST carry both `channel_id` and `user_id`. The server
 *      always emits these post-T-57; missing values mean either an old
 *      payload (drop — DM panes were already broken for those clients) or
 *      a forged/stripped payload (drop).
 *   2. The current session's user.id MUST be defined and equal to
 *      `data.user_id`. On cold start, between auth-store hydration and
 *      `bootstrapSession()` resolving, `user?.id` is undefined — taps in
 *      that window are dropped rather than allowed through (re-tap after
 *      bootstrap works).
 *
 * Routing: `kind === 'dm'` → DM pane; anything else → channel pane.
 *
 * `setPaneContent` with identical args is intentionally idempotent; multi-tap
 * does not need a dedupe map.
 */
export function navigateFromPush(data: PushNavigationData): void {
  if (!data.channel_id || !data.user_id) return;

  const currentUserId = useAuthStore.getState().user?.id;
  if (!currentUserId || currentUserId !== data.user_id) return;

  if (data.kind === 'dm') {
    navigateToDMConversation(data.channel_id);
  } else {
    navigateToChannel(data.channel_id);
  }
}
