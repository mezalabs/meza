import type { CustomEmoji } from '@meza/gen/meza/v1/models_pb.ts';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { loadEmojiCache } from '../lib/emojiCache.ts';
import { useAuthStore } from './auth.ts';

function loadFromCache(): Partial<EmojiState> {
  try {
    const userId = useAuthStore.getState().user?.id;
    if (!userId) return {};
    const cached = loadEmojiCache(userId);
    if (!cached) return {};
    // StoredEmoji objects are structurally compatible with CustomEmoji
    return {
      byServer: cached.byServer as unknown as Record<string, CustomEmoji[]>,
      personal: cached.personal as unknown as CustomEmoji[] | null,
    };
  } catch {
    return {};
  }
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

// Start persisting emoji changes to localStorage (debounced).
import { initEmojiCachePersistence } from '../lib/emojiCache.ts';
initEmojiCachePersistence();
