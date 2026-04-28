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
 * point — Capacitor tap, web service worker postMessage, and Electron
 * deep-link URL. Field names mirror the server pushPayload exactly.
 */
export interface PushNavigationData {
  type?: string;
  channel_id?: string;
  user_id?: string;
}

/**
 * Single dispatch helper used by all four push entry points (Capacitor,
 * Web SW, Electron, and the cold-start launch path).
 *
 *   1. Drops the tap if `user_id` does not match the currently signed-in
 *      user — prevents cross-account leak when a stale tray notification
 *      from a previous session is tapped after user switch (Case B).
 *   2. Routes to the DM pane shape when `type === 'dm'`, otherwise to the
 *      channel pane. Falling through to channel preserves the legacy
 *      behavior for older server payloads with no `type` field.
 */
export function navigateFromPush(data: PushNavigationData): void {
  if (!data.channel_id) return;

  const currentUserId = useAuthStore.getState().user?.id;
  if (data.user_id && currentUserId && data.user_id !== currentUserId) {
    // Notification belongs to a different signed-in account — drop.
    return;
  }

  if (data.type === 'dm') {
    navigateToDMConversation(data.channel_id);
  } else {
    navigateToChannel(data.channel_id);
  }
}
