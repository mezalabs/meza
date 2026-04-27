import { isSessionReady, setPendingChannel, useAuthStore } from '@meza/core';
import { useTilingStore } from '@meza/ui';

/** Navigate the focused pane to a channel (used by push notification handlers). */
export function navigateToChannel(channelId: string): void {
  const store = useTilingStore.getState();
  store.setPaneContent(store.focusedPaneId, {
    type: 'channel',
    channelId,
  });
}

/**
 * Request navigation to a channel from a deep link or push notification.
 *
 * - Drops the request if no user is authenticated. Without server-side
 *   `user_id` in the payload we can't tell which account a notification was
 *   intended for, so a tap during the logged-out window must not buffer a
 *   channel id that the next user to log in would inherit.
 * - If auth + E2EE session are ready, navigates immediately.
 * - Otherwise buffers the channel id for `main.tsx` to drain once
 *   `sessionReady && isAuthenticated` flips true (cold start with persisted
 *   auth, where bootstrap is in-flight when the tap arrives).
 */
export function requestChannelNavigation(channelId: string): void {
  if (!useAuthStore.getState().isAuthenticated) return;
  if (isSessionReady()) {
    navigateToChannel(channelId);
    return;
  }
  setPendingChannel(channelId);
}
