import type { Server } from '@meza/gen/meza/v1/models_pb.ts';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

export interface ServerState {
  servers: Record<string, Server>;
  isLoading: boolean;
  error: string | null;
}

export interface ServerActions {
  setServers: (servers: Server[]) => void;
  addServer: (server: Server) => void;
  removeServer: (serverId: string) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  reset: () => void;
}

export const useServerStore = create<ServerState & ServerActions>()(
  immer((set) => ({
    servers: {},
    isLoading: false,
    error: null,

    setServers: (servers) => {
      set((state) => {
        state.servers = {};
        for (const s of servers) {
          state.servers[s.id] = s;
        }
        state.isLoading = false;
      });
    },

    addServer: (server) => {
      set((state) => {
        state.servers[server.id] = server;
      });
    },

    removeServer: (serverId) => {
      set((state) => {
        delete state.servers[serverId];
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
        state.servers = {};
        state.isLoading = false;
        state.error = null;
      });
    },
  })),
);
