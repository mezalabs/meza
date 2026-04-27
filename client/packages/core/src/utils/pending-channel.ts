/**
 * Buffers a channel ID requested by a deep link or push notification when
 * the UI is not yet ready to receive navigation (e.g. during a cold start
 * before the auth/E2EE session has bootstrapped). The consumer drains the
 * buffer once it can act on it.
 *
 * Module-level state (not Zustand) because writers run before React mounts
 * and the single consumer drains synchronously — a listener API would add
 * complexity without callers.
 *
 * Not persisted to localStorage: a fresh app launch with no notification
 * tap must NOT replay an old buffered channel ID.
 */

let pendingChannelId: string | null = null;

export function setPendingChannel(channelId: string): void {
  pendingChannelId = channelId;
}

export function consumePendingChannel(): string | null {
  const out = pendingChannelId;
  pendingChannelId = null;
  return out;
}

export function getPendingChannel(): string | null {
  return pendingChannelId;
}

export function clearPendingChannel(): void {
  pendingChannelId = null;
}
