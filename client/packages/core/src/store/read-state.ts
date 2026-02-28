import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

interface ReadStateData {
  lastReadMessageId: string;
  unreadCount: number;
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
  getUnreadCount: (channelId: string) => number;
  hasUnread: (channelId: string) => boolean;
  reset: () => void;
}

export const useReadStateStore = create<ReadStateState & ReadStateActions>()(
  immer((set, get) => ({
    byChannel: {},

    setReadStates: (states) => {
      set((state) => {
        for (const s of states) {
          state.byChannel[s.channelId] = {
            lastReadMessageId: s.lastReadMessageId,
            unreadCount: s.unreadCount,
          };
        }
      });
    },

    updateReadState: (channelId, lastReadMessageId, unreadCount) => {
      set((state) => {
        state.byChannel[channelId] = { lastReadMessageId, unreadCount };
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

    reset: () => {
      set((state) => {
        state.byChannel = {};
      });
    },
  })),
);
