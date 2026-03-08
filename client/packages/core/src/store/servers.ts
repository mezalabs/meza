import type { Server } from '@meza/gen/meza/v1/models_pb.ts';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { HOME_INSTANCE } from '../gateway/gateway.ts';

export interface ServerState {
  /** Two-level nesting: byInstance[instanceUrl][serverId] = Server */
  byInstance: Record<string, Record<string, Server>>;
  /**
   * Backward-compatible mirror of byInstance[HOME_INSTANCE].
   * Kept in sync automatically — use getServers(instanceUrl) for satellite data.
   */
  servers: Record<string, Server>;
  isLoading: boolean;
  error: string | null;
}

export interface ServerActions {
  getServers: (instanceUrl?: string) => Record<string, Server>;
  setServers: (servers: Server[], instanceUrl?: string) => void;
  addServer: (server: Server, instanceUrl?: string) => void;
  removeServer: (serverId: string, instanceUrl?: string) => void;
  removeInstanceData: (instanceUrl: string) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  reset: () => void;
}

/** Sync the backward-compat `servers` property from byInstance[HOME_INSTANCE]. */
function syncCompat(state: ServerState) {
  state.servers = state.byInstance[HOME_INSTANCE] ?? {};
}

export const useServerStore = create<ServerState & ServerActions>()(
  immer((set, get) => ({
    byInstance: {},
    servers: {},
    isLoading: false,
    error: null,

    getServers: (instanceUrl = HOME_INSTANCE) => {
      return get().byInstance[instanceUrl] ?? {};
    },

    setServers: (servers, instanceUrl = HOME_INSTANCE) => {
      set((state) => {
        const bucket: Record<string, Server> = {};
        for (const s of servers) {
          bucket[s.id] = s;
        }
        state.byInstance[instanceUrl] = bucket;
        state.isLoading = false;
        syncCompat(state);
      });
    },

    addServer: (server, instanceUrl = HOME_INSTANCE) => {
      set((state) => {
        if (!state.byInstance[instanceUrl]) {
          state.byInstance[instanceUrl] = {};
        }
        state.byInstance[instanceUrl][server.id] = server;
        syncCompat(state);
      });
    },

    removeServer: (serverId, instanceUrl = HOME_INSTANCE) => {
      set((state) => {
        const bucket = state.byInstance[instanceUrl];
        if (bucket) {
          delete bucket[serverId];
        }
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
        state.servers = {};
        state.isLoading = false;
        state.error = null;
      });
    },
  })),
);
