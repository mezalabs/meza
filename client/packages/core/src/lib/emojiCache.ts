/**
 * Client-side emoji cache using localStorage.
 *
 * Persists custom emoji data across page refreshes so the client doesn't
 * need to re-fetch from the API on every load. The gateway's real-time
 * events (emojiCreate/Update/Delete) keep the in-memory store fresh,
 * and the debounced write ensures the cache stays in sync.
 */

import { useAuthStore } from '../store/auth.ts';
import { useEmojiStore } from '../store/emojis.ts';

const CACHE_KEY = 'meza:emoji-cache';
const CACHE_VERSION = 1;
const DEBOUNCE_MS = 1000;
/** Max number of reaction-enriched emojis to persist in localStorage. */
const MAX_CACHED_BY_ID = 500;

/** Stripped-down emoji for storage — omits protobuf Timestamp fields. */
export interface StoredEmoji {
  id: string;
  serverId: string;
  name: string;
  imageUrl: string;
  animated: boolean;
  creatorId: string;
  userId: string;
}

interface EmojiCache {
  version: number;
  userId: string;
  byServer: Record<string, StoredEmoji[]>;
  personal: StoredEmoji[] | null;
  byId?: Record<string, StoredEmoji>;
}

function toStored({
  id,
  serverId,
  name,
  imageUrl,
  animated,
  creatorId,
  userId,
}: StoredEmoji): StoredEmoji {
  return { id, serverId, name, imageUrl, animated, creatorId, userId };
}

/**
 * Load emoji cache from localStorage.
 * Returns null if the cache is missing, corrupt, wrong version, or belongs
 * to a different user.
 */
export function loadEmojiCache(userId: string): {
  byServer: Record<string, StoredEmoji[]>;
  personal: StoredEmoji[] | null;
  byId: Record<string, StoredEmoji>;
} | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const cache = JSON.parse(raw) as EmojiCache;
    if (
      typeof cache !== 'object' ||
      cache === null ||
      cache.version !== CACHE_VERSION ||
      cache.userId !== userId ||
      typeof cache.byServer !== 'object'
    ) {
      localStorage.removeItem(CACHE_KEY);
      return null;
    }
    return { byServer: cache.byServer, personal: cache.personal, byId: cache.byId ?? {} };
  } catch {
    // Corrupt data — discard
    try {
      localStorage.removeItem(CACHE_KEY);
    } catch {}
    return null;
  }
}

/** Remove the emoji cache from localStorage and cancel any pending write. */
export function clearEmojiCache(): void {
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  try {
    localStorage.removeItem(CACHE_KEY);
  } catch {
    // ignore — private browsing or unavailable
  }
}

let writeTimer: ReturnType<typeof setTimeout> | null = null;

function writeCache(): void {
  const state = useEmojiStore.getState();
  const userId = useAuthStore.getState().user?.id;
  if (!userId) return;

  try {
    const cache: EmojiCache = {
      version: CACHE_VERSION,
      userId,
      byServer: Object.fromEntries(
        Object.entries(state.byServer).map(([sid, emojis]) => [
          sid,
          emojis.map(toStored),
        ]),
      ),
      personal: state.personal ? state.personal.map(toStored) : null,
      byId: Object.fromEntries(
        Object.entries(state.byId)
          .slice(-MAX_CACHED_BY_ID)
          .map(([id, emoji]) => [id, toStored(emoji)]),
      ),
    };
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch {
    // Quota exceeded or private browsing — silently skip
  }
}

/**
 * Start persisting emoji store changes to localStorage.
 * Writes are debounced to avoid rapid-fire localStorage updates
 * during bulk gateway events.
 *
 * Call once at app startup (e.g. in the store module or app entry).
 */
export function initEmojiCachePersistence(): void {
  // Persist emoji store changes to localStorage (debounced)
  useEmojiStore.subscribe(() => {
    // Skip writes when logged out (prevents ghost writes after reset)
    if (!useAuthStore.getState().user?.id) return;
    if (writeTimer) clearTimeout(writeTimer);
    writeTimer = setTimeout(() => {
      writeTimer = null;
      writeCache();
    }, DEBOUNCE_MS);
  });

  // Reset emoji store + cache when user logs out.
  // This avoids a circular import (auth.ts cannot import emojis.ts).
  let prevUserId = useAuthStore.getState().user?.id ?? null;
  useAuthStore.subscribe(() => {
    const userId = useAuthStore.getState().user?.id ?? null;
    if (prevUserId && !userId) {
      // User logged out — clean up
      useEmojiStore.getState().reset();
      clearEmojiCache();
    }
    prevUserId = userId;
  });
}
