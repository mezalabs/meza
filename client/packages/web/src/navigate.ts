import { useTilingStore } from '@meza/ui';

/** Navigate the focused pane to a channel (used by push notification handlers). */
export function navigateToChannel(channelId: string): void {
  const store = useTilingStore.getState();
  store.setPaneContent(store.focusedPaneId, {
    type: 'channel',
    channelId,
  });
}
