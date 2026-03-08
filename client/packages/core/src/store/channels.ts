import type { Channel } from '@meza/gen/meza/v1/models_pb.ts';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { HOME_INSTANCE } from '../gateway/gateway.ts';

type InstanceBucket = {
  byServer: Record<string, Channel[]>;
  channelToServer: Record<string, string>;
};

export interface ChannelState {
  /** Two-level nesting: byInstance[instanceUrl] = { byServer, channelToServer } */
  byInstance: Record<string, InstanceBucket>;
  /**
   * Backward-compatible mirror of byInstance[HOME_INSTANCE].byServer.
   * Kept in sync automatically.
   */
  byServer: Record<string, Channel[]>;
  /**
   * Backward-compatible mirror of byInstance[HOME_INSTANCE].channelToServer.
   * Kept in sync automatically.
   */
  channelToServer: Record<string, string>;
  isLoading: boolean;
  error: string | null;
}

export interface ChannelActions {
  getByServer: (instanceUrl?: string) => Record<string, Channel[]>;
  getChannelToServer: (instanceUrl?: string) => Record<string, string>;
  setChannels: (
    serverId: string,
    channels: Channel[],
    instanceUrl?: string,
  ) => void;
  addChannel: (channel: Channel, instanceUrl?: string) => void;
  updateChannel: (channel: Channel, instanceUrl?: string) => void;
  removeChannel: (channelId: string, instanceUrl?: string) => void;
  removeServerChannels: (serverId: string, instanceUrl?: string) => void;
  removeInstanceData: (instanceUrl: string) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  reset: () => void;
}

function ensureBucket(
  state: { byInstance: ChannelState['byInstance'] },
  instanceUrl: string,
): InstanceBucket {
  if (!state.byInstance[instanceUrl]) {
    state.byInstance[instanceUrl] = { byServer: {}, channelToServer: {} };
  }
  return state.byInstance[instanceUrl];
}

/** Sync backward-compat properties from byInstance[HOME_INSTANCE]. */
function syncCompat(state: ChannelState) {
  const home = state.byInstance[HOME_INSTANCE];
  state.byServer = home?.byServer ?? {};
  state.channelToServer = home?.channelToServer ?? {};
}

export const useChannelStore = create<ChannelState & ChannelActions>()(
  immer((set, get) => ({
    byInstance: {},
    byServer: {},
    channelToServer: {},
    isLoading: false,
    error: null,

    getByServer: (instanceUrl = HOME_INSTANCE) => {
      return get().byInstance[instanceUrl]?.byServer ?? {};
    },

    getChannelToServer: (instanceUrl = HOME_INSTANCE) => {
      return get().byInstance[instanceUrl]?.channelToServer ?? {};
    },

    setChannels: (serverId, channels, instanceUrl = HOME_INSTANCE) => {
      set((state) => {
        const bucket = ensureBucket(state, instanceUrl);
        bucket.byServer[serverId] = [...channels].sort(
          (a, b) => a.position - b.position,
        );
        for (const ch of channels) {
          bucket.channelToServer[ch.id] = serverId;
        }
        state.isLoading = false;
        syncCompat(state);
      });
    },

    addChannel: (channel, instanceUrl = HOME_INSTANCE) => {
      set((state) => {
        const bucket = ensureBucket(state, instanceUrl);
        const list = bucket.byServer[channel.serverId] ?? [];
        if (list.some((c) => c.id === channel.id)) return;
        list.push(channel);
        list.sort((a, b) => a.position - b.position);
        bucket.byServer[channel.serverId] = list;
        bucket.channelToServer[channel.id] = channel.serverId;
        syncCompat(state);
      });
    },

    updateChannel: (channel, instanceUrl = HOME_INSTANCE) => {
      set((state) => {
        const bucket = state.byInstance[instanceUrl];
        if (!bucket) return;
        const list = bucket.byServer[channel.serverId];
        if (!list) return;
        const idx = list.findIndex((c) => c.id === channel.id);
        if (idx !== -1) {
          list[idx] = channel;
          list.sort((a, b) => a.position - b.position);
        }
        syncCompat(state);
      });
    },

    removeChannel: (channelId, instanceUrl = HOME_INSTANCE) => {
      set((state) => {
        const bucket = state.byInstance[instanceUrl];
        if (!bucket) return;
        const serverId = bucket.channelToServer[channelId];
        if (!serverId) return;
        const list = bucket.byServer[serverId];
        if (list) {
          const idx = list.findIndex((c) => c.id === channelId);
          if (idx !== -1) {
            list.splice(idx, 1);
          }
        }
        delete bucket.channelToServer[channelId];
        syncCompat(state);
      });
    },

    removeServerChannels: (serverId, instanceUrl = HOME_INSTANCE) => {
      set((state) => {
        const bucket = state.byInstance[instanceUrl];
        if (!bucket) return;
        const list = bucket.byServer[serverId];
        if (list) {
          for (const ch of list) {
            delete bucket.channelToServer[ch.id];
          }
        }
        delete bucket.byServer[serverId];
        syncCompat(state);
      });
    },

    removeInstanceData: (instanceUrl) => {
      set((state) => {
        delete state.byInstance[instanceUrl];
        syncCompat(state);
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
        state.byInstance = {};
        state.byServer = {};
        state.channelToServer = {};
        state.isLoading = false;
        state.error = null;
      });
    },
  })),
);
