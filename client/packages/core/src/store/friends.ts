import type { FriendRequestEntry } from '@meza/gen/meza/v1/chat_pb.ts';
import type { User } from '@meza/gen/meza/v1/models_pb.ts';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

export interface FriendState {
  friends: User[];
  incomingRequests: FriendRequestEntry[];
  outgoingRequests: FriendRequestEntry[];
}

export interface FriendActions {
  setFriends: (friends: User[]) => void;
  addFriend: (user: User) => void;
  removeFriend: (userId: string) => void;
  isFriend: (userId: string) => boolean;
  setIncomingRequests: (requests: FriendRequestEntry[]) => void;
  addIncomingRequest: (request: FriendRequestEntry) => void;
  removeIncomingRequest: (userId: string) => void;
  setOutgoingRequests: (requests: FriendRequestEntry[]) => void;
  addOutgoingRequest: (request: FriendRequestEntry) => void;
  removeOutgoingRequest: (userId: string) => void;
  /**
   * Composite action: remove from both request lists and add as friend
   * in a single Immer transaction, avoiding intermediate render states.
   */
  acceptFriend: (user: User) => void;
  getRelationship: (
    userId: string,
  ) => 'friends' | 'incoming' | 'outgoing' | 'none';
  reset: () => void;
}

export const useFriendStore = create<FriendState & FriendActions>()(
  immer((set, get) => ({
    friends: [],
    incomingRequests: [],
    outgoingRequests: [],

    setFriends: (friends) => {
      set((state) => {
        state.friends = friends;
      });
    },

    addFriend: (user) => {
      set((state) => {
        if (!state.friends.some((u) => u.id === user.id)) {
          state.friends.unshift(user);
        }
      });
    },

    removeFriend: (userId) => {
      set((state) => {
        state.friends = state.friends.filter((u) => u.id !== userId);
      });
    },

    isFriend: (userId) => {
      return get().friends.some((u) => u.id === userId);
    },

    setIncomingRequests: (requests) => {
      set((state) => {
        state.incomingRequests = requests;
      });
    },

    addIncomingRequest: (request) => {
      set((state) => {
        if (
          !state.incomingRequests.some((r) => r.user?.id === request.user?.id)
        ) {
          state.incomingRequests.unshift(request);
        }
      });
    },

    removeIncomingRequest: (userId) => {
      set((state) => {
        state.incomingRequests = state.incomingRequests.filter(
          (r) => r.user?.id !== userId,
        );
      });
    },

    setOutgoingRequests: (requests) => {
      set((state) => {
        state.outgoingRequests = requests;
      });
    },

    addOutgoingRequest: (request) => {
      set((state) => {
        if (
          !state.outgoingRequests.some((r) => r.user?.id === request.user?.id)
        ) {
          state.outgoingRequests.unshift(request);
        }
      });
    },

    removeOutgoingRequest: (userId) => {
      set((state) => {
        state.outgoingRequests = state.outgoingRequests.filter(
          (r) => r.user?.id !== userId,
        );
      });
    },

    acceptFriend: (user) => {
      set((state) => {
        state.outgoingRequests = state.outgoingRequests.filter(
          (r) => r.user?.id !== user.id,
        );
        state.incomingRequests = state.incomingRequests.filter(
          (r) => r.user?.id !== user.id,
        );
        if (!state.friends.some((u) => u.id === user.id)) {
          state.friends.unshift(user);
        }
      });
    },

    getRelationship: (userId) => {
      const state = get();
      if (state.friends.some((u) => u.id === userId)) return 'friends';
      if (state.incomingRequests.some((r) => r.user?.id === userId))
        return 'incoming';
      if (state.outgoingRequests.some((r) => r.user?.id === userId))
        return 'outgoing';
      return 'none';
    },

    reset: () => {
      set((state) => {
        state.friends = [];
        state.incomingRequests = [];
        state.outgoingRequests = [];
      });
    },
  })),
);
