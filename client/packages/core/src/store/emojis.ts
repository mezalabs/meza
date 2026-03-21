import type { CustomEmoji } from '@meza/gen/meza/v1/models_pb.ts';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { loadEmojiCache } from '../lib/emojiCache.ts';

/**
 * Tracks which server IDs were populated from cache (not yet refreshed
 * from the API). UI components use this to know they should still
 * fire an API call even though the store has data.
 */
export const cachedServerIds = new Set<string>();
let personalFromCache = false;

function loadFromCache(): Partial<EmojiState> {
  try {
    // Read userId directly from localStorage to avoid circular import
    // timing issues with useAuthStore (which may not be initialized yet).
    const userJson = localStorage.getItem('meza:user');
    const userId = userJson ? (JSON.parse(userJson) as { id?: string }).id : undefined;
    if (!userId) return {};
    const cached = loadEmojiCache(userId);
    if (!cached) return {};
    // Track which data came from cache so UI components know to refresh
    for (const sid of Object.keys(cached.byServer)) {
      cachedServerIds.add(sid);
    }
    if (cached.personal) personalFromCache = true;
    // StoredEmoji objects are structurally compatible with CustomEmoji
    return {
      byServer: cached.byServer as unknown as Record<string, CustomEmoji[]>,
      personal: cached.personal as unknown as CustomEmoji[] | null,
    };
  } catch {
    return {};
  }
}

/** Returns true if the personal emojis came from cache and haven't been refreshed. */
export function isPersonalFromCache(): boolean {
  return personalFromCache;
}

/** Mark a server as refreshed (API data received). */
export function markServerRefreshed(serverId: string): void {
  cachedServerIds.delete(serverId);
}

/** Mark personal emojis as refreshed. */
export function markPersonalRefreshed(): void {
  personalFromCache = false;
}

export interface EmojiState {
  byServer: Record<string, CustomEmoji[]>;
  personal: CustomEmoji[] | null;
  error: string | null;
}

export interface EmojiActions {
  setEmojis: (serverId: string, emojis: CustomEmoji[]) => void;
  setPersonalEmojis: (emojis: CustomEmoji[]) => void;
  addEmoji: (emoji: CustomEmoji) => void;
  updateEmoji: (emoji: CustomEmoji) => void;
  removeEmoji: (serverId: string, emojiId: string) => void;
  removeServerEmojis: (serverId: string) => void;
  setError: (error: string | null) => void;
  reset: () => void;
}

export const useEmojiStore = create<EmojiState & EmojiActions>()(
  immer((set) => ({
    byServer: {},
    personal: null,
    error: null,
    ...loadFromCache(),

    setEmojis: (serverId, emojis) => {
      set((state) => {
        state.byServer[serverId] = [...emojis].sort((a, b) =>
          a.name.localeCompare(b.name),
        );
      });
    },

    setPersonalEmojis: (emojis) => {
      set((state) => {
        state.personal = [...emojis].sort((a, b) =>
          a.name.localeCompare(b.name),
        );
      });
    },

    addEmoji: (emoji) => {
      set((state) => {
        if (emoji.serverId) {
          const list = state.byServer[emoji.serverId] ?? [];
          if (list.some((e) => e.id === emoji.id)) return;
          list.push(emoji);
          list.sort((a, b) => a.name.localeCompare(b.name));
          state.byServer[emoji.serverId] = list;
        } else {
          if (!state.personal) state.personal = [];
          if (state.personal.some((e) => e.id === emoji.id)) return;
          state.personal.push(emoji);
          state.personal.sort((a, b) => a.name.localeCompare(b.name));
        }
      });
    },

    updateEmoji: (emoji) => {
      set((state) => {
        if (emoji.serverId) {
          const list = state.byServer[emoji.serverId];
          if (!list) return;
          const idx = list.findIndex((e) => e.id === emoji.id);
          if (idx !== -1) {
            list[idx] = emoji;
            list.sort((a, b) => a.name.localeCompare(b.name));
          }
        } else {
          if (!state.personal) return;
          const idx = state.personal.findIndex((e) => e.id === emoji.id);
          if (idx !== -1) {
            state.personal[idx] = emoji;
            state.personal.sort((a, b) => a.name.localeCompare(b.name));
          }
        }
      });
    },

    removeEmoji: (serverId, emojiId) => {
      set((state) => {
        if (serverId) {
          const list = state.byServer[serverId];
          if (!list) return;
          const idx = list.findIndex((e) => e.id === emojiId);
          if (idx !== -1) list.splice(idx, 1);
        } else {
          if (!state.personal) return;
          const idx = state.personal.findIndex((e) => e.id === emojiId);
          if (idx !== -1) state.personal.splice(idx, 1);
        }
      });
    },

    removeServerEmojis: (serverId) => {
      set((state) => {
        delete state.byServer[serverId];
      });
    },

    setError: (error) => {
      set((state) => {
        state.error = error;
      });
    },

    reset: () => {
      set((state) => {
        state.byServer = {};
        state.personal = null;
        state.error = null;
      });
    },
  })),
);

// Defer persistence setup to a microtask so all store modules finish
// evaluating first. This avoids side effects during module evaluation
// that can race with auth store initialization.
queueMicrotask(() => {
  import('../lib/emojiCache.ts').then(({ initEmojiCachePersistence }) => {
    initEmojiCachePersistence();
  });
});
