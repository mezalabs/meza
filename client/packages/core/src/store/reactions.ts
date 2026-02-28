import type { ReactionGroup } from '@meza/gen/meza/v1/models_pb.ts';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

export interface ReactionState {
  /** Reaction groups keyed by message ID. */
  byMessage: Record<string, ReactionGroup[]>;
}

export interface ReactionActions {
  setReactions: (messageId: string, groups: ReactionGroup[]) => void;
  setBulkReactions: (reactions: Record<string, ReactionGroup[]>) => void;
  addReaction: (
    messageId: string,
    emoji: string,
    userId: string,
    isMe: boolean,
  ) => void;
  removeReaction: (
    messageId: string,
    emoji: string,
    userId: string,
    isMe: boolean,
  ) => void;
  clearMessage: (messageId: string) => void;
  reset: () => void;
}

export const useReactionStore = create<ReactionState & ReactionActions>()(
  immer((set) => ({
    byMessage: {},

    setReactions: (messageId, groups) => {
      set((state) => {
        state.byMessage[messageId] = groups;
      });
    },

    setBulkReactions: (reactions) => {
      set((state) => {
        for (const [messageId, groups] of Object.entries(reactions)) {
          state.byMessage[messageId] = groups;
        }
      });
    },

    addReaction: (messageId, emoji, userId, isMe) => {
      set((state) => {
        const groups = state.byMessage[messageId] ?? [];
        const existing = groups.find((g) => g.emoji === emoji);
        if (existing) {
          if (existing.userIds.includes(userId)) return;
          existing.userIds.push(userId);
          if (isMe) existing.me = true;
        } else {
          groups.push({ emoji, me: isMe, userIds: [userId] } as ReactionGroup);
          state.byMessage[messageId] = groups;
        }
      });
    },

    removeReaction: (messageId, emoji, userId, isMe) => {
      set((state) => {
        const groups = state.byMessage[messageId];
        if (!groups) return;
        const idx = groups.findIndex((g) => g.emoji === emoji);
        if (idx === -1) return;
        const group = groups[idx];
        group.userIds = group.userIds.filter((id) => id !== userId);
        if (group.userIds.length === 0) {
          groups.splice(idx, 1);
        } else if (isMe) {
          group.me = false;
        }
      });
    },

    clearMessage: (messageId) => {
      set((state) => {
        delete state.byMessage[messageId];
      });
    },

    reset: () => {
      set((state) => {
        state.byMessage = {};
      });
    },
  })),
);
