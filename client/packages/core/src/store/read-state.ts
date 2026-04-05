import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

interface ReadStateData {
  lastReadMessageId: string;
  unreadCount: number;
  /** Tracks @mentions, @everyone, and DM messages — not just mentions. */
  mentionOrDmCount: number;
}

export interface ReadStateState {
  byChannel: Record<string, ReadStateData>;
}

export interface ReadStateActions {
  setReadStates: (
    states: Array<{
      channelId: string;
      lastReadMessageId: string;
      unreadCount: number;
    }>,
  ) => void;
  updateReadState: (
    channelId: string,
    lastReadMessageId: string,
    unreadCount: number,
  ) => void;
  incrementUnread: (channelId: string) => void;
  incrementMentionOrDm: (channelId: string) => void;
  getUnreadCount: (channelId: string) => number;
  hasUnread: (channelId: string) => boolean;
  getTotalUnreadCount: () => number;
  getTotalMentionOrDmCount: () => number;
  reset: () => void;
}

export const useReadStateStore = create<ReadStateState & ReadStateActions>()(
  immer((set, get) => ({
    byChannel: {},

    setReadStates: (states) => {
      set((state) => {
        // Replace the entire map so stale counts from a previous gateway
        // connection (within the same page session) are cleared.
        // mentionCount resets to 0 — it's client-side only and rebuilds
        // as new messages arrive.
        const fresh: Record<string, ReadStateData> = {};
        for (const s of states) {
          fresh[s.channelId] = {
            lastReadMessageId: s.lastReadMessageId,
            unreadCount: s.unreadCount,
            mentionOrDmCount: 0,
          };
        }
        state.byChannel = fresh;
      });
    },

    updateReadState: (channelId, lastReadMessageId, unreadCount) => {
      set((state) => {
        state.byChannel[channelId] = {
          lastReadMessageId,
          unreadCount,
          mentionOrDmCount: unreadCount === 0 ? 0 : (state.byChannel[channelId]?.mentionOrDmCount ?? 0),
        };
      });
    },

    incrementUnread: (channelId) => {
      set((state) => {
        const existing = state.byChannel[channelId];
        if (existing) {
          existing.unreadCount++;
        } else {
          state.byChannel[channelId] = {
            lastReadMessageId: '',
            unreadCount: 1,
            mentionOrDmCount: 0,
          };
        }
      });
    },

    incrementMentionOrDm: (channelId) => {
      set((state) => {
        const existing = state.byChannel[channelId];
        if (existing) {
          existing.mentionOrDmCount++;
        } else {
          state.byChannel[channelId] = {
            lastReadMessageId: '',
            unreadCount: 1,
            mentionOrDmCount: 1,
          };
        }
      });
    },

    getUnreadCount: (channelId) => {
      return get().byChannel[channelId]?.unreadCount ?? 0;
    },

    hasUnread: (channelId) => {
      return (get().byChannel[channelId]?.unreadCount ?? 0) > 0;
    },

    getTotalUnreadCount: () => {
      let total = 0;
      for (const data of Object.values(get().byChannel)) {
        total += data.unreadCount;
      }
      return total;
    },

    getTotalMentionOrDmCount: () => {
      let total = 0;
      for (const data of Object.values(get().byChannel)) {
        total += data.mentionOrDmCount;
      }
      return total;
    },

    reset: () => {
      set((state) => {
        state.byChannel = {};
      });
    },
  })),
);
