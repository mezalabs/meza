import type { CustomEmoji } from '@meza/gen/meza/v1/models_pb.ts';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

export interface EmojiState {
  byServer: Record<string, CustomEmoji[]>;
  personal: CustomEmoji[];
  isLoading: boolean;
  error: string | null;
}

export interface EmojiActions {
  setEmojis: (serverId: string, emojis: CustomEmoji[]) => void;
  setPersonalEmojis: (emojis: CustomEmoji[]) => void;
  addEmoji: (emoji: CustomEmoji) => void;
  updateEmoji: (emoji: CustomEmoji) => void;
  removeEmoji: (serverId: string, emojiId: string) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  reset: () => void;
}

export const useEmojiStore = create<EmojiState & EmojiActions>()(
  immer((set) => ({
    byServer: {},
    personal: [],
    isLoading: false,
    error: null,

    setEmojis: (serverId, emojis) => {
      set((state) => {
        state.byServer[serverId] = [...emojis].sort((a, b) =>
          a.name.localeCompare(b.name),
        );
        state.isLoading = false;
      });
    },

    setPersonalEmojis: (emojis) => {
      set((state) => {
        state.personal = [...emojis].sort((a, b) =>
          a.name.localeCompare(b.name),
        );
        state.isLoading = false;
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
          const idx = state.personal.findIndex((e) => e.id === emojiId);
          if (idx !== -1) state.personal.splice(idx, 1);
        }
      });
    },

    setLoading: (loading) => {
      set((state) => {
        state.isLoading = loading;
      });
    },

    setError: (error) => {
      set((state) => {
        state.error = error;
        state.isLoading = false;
      });
    },

    reset: () => {
      set((state) => {
        state.byServer = {};
        state.personal = [];
        state.isLoading = false;
        state.error = null;
      });
    },
  })),
);
