import type { ChannelGroup } from '@meza/gen/meza/v1/models_pb.ts';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

export interface ChannelGroupState {
  byServer: Record<string, ChannelGroup[]>;
  isLoading: boolean;
  error: string | null;
}

export interface ChannelGroupActions {
  setGroups: (serverId: string, groups: ChannelGroup[]) => void;
  addGroup: (group: ChannelGroup) => void;
  updateGroup: (group: ChannelGroup) => void;
  removeGroup: (serverId: string, groupId: string) => void;
  removeServerGroups: (serverId: string) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  reset: () => void;
}

export const useChannelGroupStore = create<
  ChannelGroupState & ChannelGroupActions
>()(
  immer((set) => ({
    byServer: {},
    isLoading: false,
    error: null,

    setGroups: (serverId, groups) => {
      set((state) => {
        state.byServer[serverId] = [...groups].sort(
          (a, b) => a.position - b.position,
        );
        state.isLoading = false;
      });
    },

    addGroup: (group) => {
      set((state) => {
        const list = state.byServer[group.serverId] ?? [];
        if (list.some((g) => g.id === group.id)) return;
        list.push(group);
        list.sort((a, b) => a.position - b.position);
        state.byServer[group.serverId] = list;
      });
    },

    updateGroup: (group) => {
      set((state) => {
        const list = state.byServer[group.serverId];
        if (!list) return;
        const idx = list.findIndex((g) => g.id === group.id);
        if (idx !== -1) {
          list[idx] = group;
          list.sort((a, b) => a.position - b.position);
        }
      });
    },

    removeGroup: (serverId, groupId) => {
      set((state) => {
        const list = state.byServer[serverId];
        if (!list) return;
        const idx = list.findIndex((g) => g.id === groupId);
        if (idx !== -1) {
          list.splice(idx, 1);
        }
      });
    },

    removeServerGroups: (serverId) => {
      set((state) => {
        delete state.byServer[serverId];
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
        state.isLoading = false;
        state.error = null;
      });
    },
  })),
);
