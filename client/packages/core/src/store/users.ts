import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import type { StoredUser } from './auth.ts';

export interface UsersState {
  profiles: Record<string, StoredUser>;
  /** Epoch ms when each profile was last fetched from the server. */
  profileFetchedAt: Record<string, number>;
}

export interface UsersActions {
  setProfile: (userId: string, profile: StoredUser) => void;
  getProfile: (userId: string) => StoredUser | undefined;
  /** Returns true if the cached profile is fresh (fetched within `ttlMs`). */
  isProfileFresh: (userId: string, ttlMs: number) => boolean;
}

export const useUsersStore = create<UsersState & UsersActions>()(
  immer((set, get) => ({
    profiles: {},
    profileFetchedAt: {},

    setProfile: (userId, profile) => {
      set((state) => {
        state.profiles[userId] = profile;
        state.profileFetchedAt[userId] = Date.now();
      });
    },

    getProfile: (userId) => {
      return get().profiles[userId];
    },

    isProfileFresh: (userId, ttlMs) => {
      const fetchedAt = get().profileFetchedAt[userId];
      return fetchedAt != null && Date.now() - fetchedAt < ttlMs;
    },
  })),
);
