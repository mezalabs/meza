import type { Server } from '@meza/gen/meza/v1/models_pb.ts';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { FEDERATION_STORAGE_KEY, useFederationStore } from './federation.ts';

/**
 * Read federated server IDs synchronously from localStorage as a fallback
 * when the federation store hasn't finished Zustand persist hydration.
 */
function readFederatedServerIdsSync(): Set<string> {
  try {
    const raw = localStorage.getItem(FEDERATION_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (parsed?.version !== 1) return new Set();
    const spokes: Record<string, { serverId?: string }> =
      parsed?.state?.spokes ?? {};
    return new Set(
      Object.values(spokes)
        .map((s) => s.serverId)
        .filter(Boolean) as string[],
    );
  } catch {
    return new Set();
  }
}

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
        // Preserve federated servers that were added via federation join.
        // Try the hydrated store first; fall back to sync localStorage read
        // if the federation store hasn't finished persist hydration yet.
        const storeIndex = useFederationStore.getState().serverIndex;
        const federatedIds =
          Object.keys(storeIndex).length > 0
            ? new Set(Object.keys(storeIndex))
            : readFederatedServerIdsSync();
        const preserved: Record<string, Server> = {};
        for (const [id, s] of Object.entries(state.servers)) {
          if (federatedIds.has(id)) {
            preserved[id] = s;
          }
        }
        state.servers = { ...preserved };
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
