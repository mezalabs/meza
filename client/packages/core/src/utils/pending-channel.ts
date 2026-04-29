// Buffer for a push-notification navigation requested before the UI is
// ready to receive it (cold-start tap fires before auth/E2EE session
// bootstraps). Module-level state matches the onSessionReady pattern:
// writers run before React mounts and the consumer drains synchronously.
// Not persisted — a fresh launch with no tap must not replay a stale
// intent. Last write wins.
//
// Carries the full PushNavigationData shape (kind + channel_id + user_id)
// so the cross-account filter in navigateFromPush can be applied at drain
// time. Filename retained from when the buffer was channel-id only.

export interface PendingPushNav {
  kind?: string;
  channel_id: string;
  user_id?: string;
}

let pending: PendingPushNav | null = null;

/** Buffer a push-nav intent for the next drain. Overwrites any previous value. */
export function setPendingPushNav(data: PendingPushNav): void {
  pending = data;
}

/** Read and clear the buffered push-nav intent (returns null if empty). */
export function consumePendingPushNav(): PendingPushNav | null {
  const out = pending;
  pending = null;
  return out;
}

/** Discard the buffer without reading it (used on logout teardown). */
export function clearPendingPushNav(): void {
  pending = null;
}
