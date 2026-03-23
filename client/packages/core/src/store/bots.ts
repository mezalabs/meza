import type { Bot } from '@meza/gen/meza/v1/models_pb.ts';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import * as botsApi from '../api/bots.ts';

export interface BotState {
  bots: Bot[];
  loading: boolean;
  error: string | null;
}

export interface BotActions {
  fetchBots: () => Promise<void>;
  createBot: (
    username: string,
    displayName: string,
  ) => Promise<Awaited<ReturnType<typeof botsApi.createBot>>>;
  deleteBot: (botId: string) => Promise<void>;
  regenerateToken: (botId: string) => Promise<{ token: string } | undefined>;
  updateBot: (
    botId: string,
    fields: { displayName?: string; description?: string; avatarUrl?: string },
  ) => Promise<Bot | undefined>;
  reset: () => void;
}

export const useBotStore = create<BotState & BotActions>()(
  immer((set) => ({
    bots: [],
    loading: false,
    error: null,

    fetchBots: async () => {
      set((state) => {
        state.loading = true;
        state.error = null;
      });
      try {
        const bots = await botsApi.listBots();
        set((state) => {
          state.bots = bots;
          state.loading = false;
        });
      } catch (err) {
        set((state) => {
          state.error =
            err instanceof Error ? err.message : 'Failed to load bots';
          state.loading = false;
        });
      }
    },

    createBot: async (username, displayName) => {
      set((state) => {
        state.error = null;
      });
      try {
        const result = await botsApi.createBot(username, displayName);
        if (result?.bot) {
          const bot = result.bot;
          set((state) => {
            state.bots.push(bot);
          });
        }
        return result;
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Failed to create bot';
        set((state) => {
          state.error = message;
        });
        throw err;
      }
    },

    deleteBot: async (botId) => {
      set((state) => {
        state.error = null;
      });
      try {
        await botsApi.deleteBot(botId);
        set((state) => {
          const idx = state.bots.findIndex((b) => b.id === botId);
          if (idx !== -1) state.bots.splice(idx, 1);
        });
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Failed to delete bot';
        set((state) => {
          state.error = message;
        });
        throw err;
      }
    },

    regenerateToken: async (botId) => {
      set((state) => {
        state.error = null;
      });
      try {
        return await botsApi.regenerateBotToken(botId);
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Failed to regenerate token';
        set((state) => {
          state.error = message;
        });
        throw err;
      }
    },

    updateBot: async (botId, fields) => {
      set((state) => {
        state.error = null;
      });
      try {
        const bot = await botsApi.updateBot(botId, fields);
        if (bot) {
          set((state) => {
            const idx = state.bots.findIndex((b) => b.id === botId);
            if (idx !== -1) {
              state.bots[idx] = bot;
            }
          });
        }
        return bot;
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Failed to update bot';
        set((state) => {
          state.error = message;
        });
        throw err;
      }
    },

    reset: () => {
      set((state) => {
        state.bots = [];
        state.loading = false;
        state.error = null;
      });
    },
  })),
);
