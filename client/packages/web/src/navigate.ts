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
 * If the auth + E2EE session are ready, navigates immediately. Otherwise
 * buffers the channel id so the consumer in main.tsx can apply it once
 * `sessionReady && isAuthenticated` flips true. This bridges the cold-start
 * gap between a notification tap firing very early and Shell being ready
 * to render the channel pane.
 */
export function requestChannelNavigation(channelId: string): void {
  if (useAuthStore.getState().isAuthenticated && isSessionReady()) {
    navigateToChannel(channelId);
    return;
  }
  setPendingChannel(channelId);
}
