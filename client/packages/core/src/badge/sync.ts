import { useNotificationSettingsStore } from '../store/notificationSettings.ts';
import { useReadStateStore } from '../store/read-state.ts';

export interface BadgeAdapter {
  setBadgeCount(count: number): void;
}

let adapter: BadgeAdapter | null = null;
let unsubReadState: (() => void) | null = null;
let unsubSettings: (() => void) | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | undefined;
let syncGeneration = 0;

function computeBadgeCount(): number {
  const { badgeMode } = useNotificationSettingsStore.getState();
  if (badgeMode === 'off') return 0;

  const store = useReadStateStore.getState();
  if (badgeMode === 'mentions_dms') {
    return store.getTotalMentionOrDmCount();
  }
  return store.getTotalUnreadCount();
}

function scheduleBadgeUpdate(): void {
  clearTimeout(debounceTimer);
  const gen = syncGeneration;
  debounceTimer = setTimeout(() => {
    if (gen !== syncGeneration || !adapter) return;
    adapter.setBadgeCount(computeBadgeCount());
  }, 150);
}

export function startBadgeSync(badgeAdapter: BadgeAdapter): void {
  stopBadgeSync();
  syncGeneration++;
  adapter = badgeAdapter;

  // Set initial badge count immediately
  adapter.setBadgeCount(computeBadgeCount());

  // Subscribe to read state changes
  unsubReadState = useReadStateStore.subscribe(scheduleBadgeUpdate);

  // Subscribe to badge mode changes so switching settings takes effect immediately
  unsubSettings = useNotificationSettingsStore.subscribe((state, prevState) => {
    if (state.badgeMode !== prevState.badgeMode) {
      scheduleBadgeUpdate();
    }
  });
}

export function stopBadgeSync(): void {
  clearTimeout(debounceTimer);
  unsubReadState?.();
  unsubSettings?.();
  unsubReadState = null;
  unsubSettings = null;
  adapter?.setBadgeCount(0);
  adapter = null;
}
