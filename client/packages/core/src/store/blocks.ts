import type { User } from '@meza/gen/meza/v1/models_pb.ts';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

export interface BlockState {
  blockedUsers: User[];
  /** IDs of blocked users when full User data is unavailable (e.g., from gateway events). */
  blockedUserIds: Record<string, true>;
}

export interface BlockActions {
  setBlockedUsers: (users: User[]) => void;
  addBlockedUser: (user: User) => void;
  /** Block a user by ID only, when full User data is not available. */
  addBlockedUserId: (userId: string) => void;
  removeBlockedUser: (userId: string) => void;
  isBlocked: (userId: string) => boolean;
  reset: () => void;
}

export const useBlockStore = create<BlockState & BlockActions>()(
  immer((set, get) => ({
    blockedUsers: [],
    blockedUserIds: {},

    setBlockedUsers: (users) => {
      set((state) => {
        state.blockedUsers = users;
        // Sync ID-only record: remove IDs that now have full User objects
        for (const u of users) {
          delete state.blockedUserIds[u.id];
        }
      });
    },

    addBlockedUser: (user) => {
      set((state) => {
        if (!state.blockedUsers.some((u) => u.id === user.id)) {
          state.blockedUsers.unshift(user);
        }
        // Remove from ID-only record since we now have the full object
        delete state.blockedUserIds[user.id];
      });
    },

    addBlockedUserId: (userId) => {
      set((state) => {
        // Only add to ID record if not already tracked as a full User
        if (!state.blockedUsers.some((u) => u.id === userId)) {
          state.blockedUserIds[userId] = true;
        }
      });
    },

    removeBlockedUser: (userId) => {
      set((state) => {
        state.blockedUsers = state.blockedUsers.filter((u) => u.id !== userId);
        delete state.blockedUserIds[userId];
      });
    },

    isBlocked: (userId) => {
      const state = get();
      return (
        state.blockedUsers.some((u) => u.id === userId) ||
        !!state.blockedUserIds[userId]
      );
    },

    reset: () => {
      set((state) => {
        state.blockedUsers = [];
        state.blockedUserIds = {};
      });
    },
  })),
);
