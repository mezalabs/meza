// Buffers a channel id requested before the UI is ready to receive
// navigation (cold-start tap fires before auth/E2EE session bootstraps).
// Module-level state matches the onSessionReady pattern: writers run
// before React mounts and the consumer drains synchronously. Not persisted
// — a fresh launch with no tap must not replay a stale id. Last write wins.

let pendingChannelId: string | null = null;

/** Buffer a channel id for the next drain. Overwrites any previous value. */
export function setPendingChannel(channelId: string): void {
  pendingChannelId = channelId;
}

/** Read and clear the buffered channel id (returns null if empty). */
export function consumePendingChannel(): string | null {
  const out = pendingChannelId;
  pendingChannelId = null;
  return out;
}

/** Discard the buffer without reading it (used on logout teardown). */
export function clearPendingChannel(): void {
  pendingChannelId = null;
}
