import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import type { StoredUser } from './auth.ts';

export interface UsersState {
  profiles: Record<string, StoredUser>;
}

export interface UsersActions {
  setProfile: (userId: string, profile: StoredUser) => void;
  getProfile: (userId: string) => StoredUser | undefined;
}

export const useUsersStore = create<UsersState & UsersActions>()(
  immer((set, get) => ({
    profiles: {},

    setProfile: (userId, profile) => {
      set((state) => {
        state.profiles[userId] = profile;
      });
    },

    getProfile: (userId) => {
      return get().profiles[userId];
    },
  })),
);
