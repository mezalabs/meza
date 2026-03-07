import { useNavigationStore, useTilingStore } from '@meza/ui';

/** Navigate the focused pane to a channel (used by push notification handlers). */
export function navigateToChannel(
  channelId: string,
  isDM = false,
): void {
  const store = useTilingStore.getState();
  const content = isDM
    ? ({ type: 'dm', conversationId: channelId } as const)
    : ({ type: 'channel', channelId } as const);
  store.setPaneContent(store.focusedPaneId, content);

  // On mobile, ensure the sidebar switches to the DMs section so the
  // context matches the navigation target.
  if (isDM) {
    useNavigationStore.getState().selectDMs();
  }
}
