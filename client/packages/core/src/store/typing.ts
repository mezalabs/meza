import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

export interface TypingState {
  byChannel: Record<string, Record<string, number>>;
}

export interface TypingActions {
  setTyping: (channelId: string, userId: string) => void;
  clearUser: (channelId: string, userId: string) => void;
  clearExpired: () => void;
  clearChannel: (channelId: string) => void;
  reset: () => void;
}

/** Module-level singleton interval for cleanup. */
let cleanupInterval: ReturnType<typeof setInterval> | null = null;

function startCleanupInterval() {
  if (cleanupInterval !== null) return;
  cleanupInterval = setInterval(() => {
    useTypingStore.getState().clearExpired();
  }, 3000);
}

function stopCleanupInterval() {
  if (cleanupInterval === null) return;
  clearInterval(cleanupInterval);
  cleanupInterval = null;
}

export const useTypingStore = create<TypingState & TypingActions>()(
  immer((set) => ({
    byChannel: {},

    setTyping: (channelId, userId) => {
      set((state) => {
        if (!state.byChannel[channelId]) {
          state.byChannel[channelId] = {};
        }
        // biome-ignore lint/style/noNonNullAssertion: assigned on line above
        state.byChannel[channelId]![userId] = Date.now() + 6000;
      });
      startCleanupInterval();
    },

    clearUser: (channelId, userId) => {
      set((state) => {
        const users = state.byChannel[channelId];
        if (!users) return;
        delete users[userId];
        if (Object.keys(users).length === 0) {
          delete state.byChannel[channelId];
        }
      });
    },

    clearExpired: () => {
      set((state) => {
        const now = Date.now();
        for (const channelId of Object.keys(state.byChannel)) {
          // biome-ignore lint/style/noNonNullAssertion: key from Object.keys guarantees existence
          const users = state.byChannel[channelId]!;
          for (const userId of Object.keys(users)) {
            // biome-ignore lint/style/noNonNullAssertion: key from Object.keys guarantees existence
            if (now > users[userId]!) {
              delete users[userId];
            }
          }
          if (Object.keys(users).length === 0) {
            delete state.byChannel[channelId];
          }
        }
        if (Object.keys(state.byChannel).length === 0) {
          stopCleanupInterval();
        }
      });
    },

    clearChannel: (channelId) => {
      set((state) => {
        delete state.byChannel[channelId];
        if (Object.keys(state.byChannel).length === 0) {
          stopCleanupInterval();
        }
      });
    },

    reset: () => {
      set((state) => {
        state.byChannel = {};
      });
      stopCleanupInterval();
    },
  })),
);
