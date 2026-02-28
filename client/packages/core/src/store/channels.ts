import type { Channel } from '@meza/gen/meza/v1/models_pb.ts';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

export interface ChannelState {
  byServer: Record<string, Channel[]>;
  channelToServer: Record<string, string>;
  isLoading: boolean;
  error: string | null;
}

export interface ChannelActions {
  setChannels: (serverId: string, channels: Channel[]) => void;
  addChannel: (channel: Channel) => void;
  updateChannel: (channel: Channel) => void;
  removeChannel: (channelId: string) => void;
  removeServerChannels: (serverId: string) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  reset: () => void;
}

export const useChannelStore = create<ChannelState & ChannelActions>()(
  immer((set) => ({
    byServer: {},
    channelToServer: {},
    isLoading: false,
    error: null,

    setChannels: (serverId, channels) => {
      set((state) => {
        state.byServer[serverId] = [...channels].sort(
          (a, b) => a.position - b.position,
        );
        for (const ch of channels) {
          state.channelToServer[ch.id] = serverId;
        }
        state.isLoading = false;
      });
    },

    addChannel: (channel) => {
      set((state) => {
        const list = state.byServer[channel.serverId] ?? [];
        if (list.some((c) => c.id === channel.id)) return;
        list.push(channel);
        list.sort((a, b) => a.position - b.position);
        state.byServer[channel.serverId] = list;
        state.channelToServer[channel.id] = channel.serverId;
      });
    },

    updateChannel: (channel) => {
      set((state) => {
        const list = state.byServer[channel.serverId];
        if (!list) return;
        const idx = list.findIndex((c) => c.id === channel.id);
        if (idx !== -1) {
          list[idx] = channel;
          list.sort((a, b) => a.position - b.position);
        }
      });
    },

    removeChannel: (channelId) => {
      set((state) => {
        const serverId = state.channelToServer[channelId];
        if (!serverId) return;
        const list = state.byServer[serverId];
        if (list) {
          const idx = list.findIndex((c) => c.id === channelId);
          if (idx !== -1) {
            list.splice(idx, 1);
          }
        }
        delete state.channelToServer[channelId];
      });
    },

    removeServerChannels: (serverId) => {
      set((state) => {
        const list = state.byServer[serverId];
        if (list) {
          for (const ch of list) {
            delete state.channelToServer[ch.id];
          }
        }
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
        state.channelToServer = {};
        state.isLoading = false;
        state.error = null;
      });
    },
  })),
);
