import type { CustomEmoji } from '@meza/gen/meza/v1/models_pb.ts';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { loadEmojiCache } from '../lib/emojiCache.ts';

function loadFromCache(): Partial<EmojiState> {
  try {
    // Read userId directly from localStorage to avoid circular import
    // timing issues with useAuthStore (which may not be initialized yet).
    const userJson = localStorage.getItem('meza:user');
    const userId = userJson
      ? (JSON.parse(userJson) as { id?: string }).id
      : undefined;
    if (!userId) return {};
    const cached = loadEmojiCache(userId);
    if (!cached) return {};
    // Track which data came from cache so UI components know to refresh
    const cachedServerIds: Record<string, true> = {};
    for (const sid of Object.keys(cached.byServer)) {
      cachedServerIds[sid] = true;
    }
    return {
      byServer: cached.byServer as unknown as Record<string, CustomEmoji[]>,
      personal: cached.personal as unknown as CustomEmoji[] | null,
      cachedServerIds,
      personalFromCache: !!cached.personal,
    };
  } catch {
    return {};
  }
}

export interface EmojiState {
  byServer: Record<string, CustomEmoji[]>;
  personal: CustomEmoji[] | null;
  error: string | null;
  /** Server IDs whose emoji data came from cache and hasn't been refreshed from API yet. */
  cachedServerIds: Record<string, true>;
  /** Whether personal emojis came from cache and haven't been refreshed yet. */
  personalFromCache: boolean;
}

export interface EmojiActions {
  setEmojis: (serverId: string, emojis: CustomEmoji[]) => void;
  setPersonalEmojis: (emojis: CustomEmoji[]) => void;
  addEmoji: (emoji: CustomEmoji) => void;
  updateEmoji: (emoji: CustomEmoji) => void;
  removeEmoji: (serverId: string, emojiId: string) => void;
  removeServerEmojis: (serverId: string) => void;
  setError: (error: string | null) => void;
  /** Mark a server's emoji data as refreshed from the API (no longer stale cache). */
  markServerRefreshed: (serverId: string) => void;
  /** Mark personal emoji data as refreshed from the API (no longer stale cache). */
  markPersonalRefreshed: () => void;
  reset: () => void;
}

export const useEmojiStore = create<EmojiState & EmojiActions>()(
  immer((set) => ({
    byServer: {},
    personal: null,
    error: null,
    cachedServerIds: {},
    personalFromCache: false,
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

    markServerRefreshed: (serverId) => {
      set((state) => {
        delete state.cachedServerIds[serverId];
      });
    },

    markPersonalRefreshed: () => {
      set((state) => {
        state.personalFromCache = false;
      });
    },

    reset: () => {
      set((state) => {
        state.byServer = {};
        state.personal = null;
        state.error = null;
        state.cachedServerIds = {};
        state.personalFromCache = false;
      });
    },
  })),
);
