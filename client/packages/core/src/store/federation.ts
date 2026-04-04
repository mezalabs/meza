import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';

const STORAGE_KEY = 'meza:federation';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SpokeConnectionStatus =
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnected'
  | 'error';

export interface SpokeConnection {
  instanceUrl: string;
  accessToken: string;
  refreshToken: string;
  shadowUserId: string;
  serverId: string;
  /** Volatile — always initialised as 'disconnected' on reload. */
  status: SpokeConnectionStatus;
  lastError: string | null;
}

export interface FederationState {
  /** Keyed by instanceUrl. */
  spokes: Record<string, SpokeConnection>;
  /** serverId → instanceUrl reverse index (derived, not persisted). */
  serverIndex: Record<string, string>;
}

export interface FederationActions {
  addSpoke(spoke: Omit<SpokeConnection, 'status' | 'lastError'>): void;
  removeSpoke(instanceUrl: string): void;
  updateSpokeTokens(
    instanceUrl: string,
    accessToken: string,
    refreshToken: string,
  ): void;
  updateSpokeStatus(
    instanceUrl: string,
    status: SpokeConnectionStatus,
    lastError?: string | null,
  ): void;
  reset(): void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Rebuild serverIndex from spokes map. */
function buildServerIndex(
  spokes: Record<string, SpokeConnection>,
): Record<string, string> {
  const idx: Record<string, string> = {};
  for (const s of Object.values(spokes)) {
    idx[s.serverId] = s.instanceUrl;
  }
  return idx;
}

/** Storage key exported for use by the setServers hydration guard. */
export const FEDERATION_STORAGE_KEY = STORAGE_KEY;

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const initialState: FederationState = {
  spokes: {},
  serverIndex: {},
};

export const useFederationStore = create<FederationState & FederationActions>()(
  persist(
    immer((set) => ({
      ...initialState,

      addSpoke: (spoke) => {
        set((state) => {
          state.spokes[spoke.instanceUrl] = {
            ...spoke,
            status: 'disconnected',
            lastError: null,
          };
          state.serverIndex[spoke.serverId] = spoke.instanceUrl;
        });
      },

      removeSpoke: (instanceUrl) => {
        set((state) => {
          const spoke = state.spokes[instanceUrl];
          if (spoke) {
            delete state.serverIndex[spoke.serverId];
            delete state.spokes[instanceUrl];
          }
        });
      },

      updateSpokeTokens: (instanceUrl, accessToken, refreshToken) => {
        set((state) => {
          const spoke = state.spokes[instanceUrl];
          if (spoke) {
            spoke.accessToken = accessToken;
            spoke.refreshToken = refreshToken;
          }
        });
      },

      updateSpokeStatus: (instanceUrl, status, lastError) => {
        set((state) => {
          const spoke = state.spokes[instanceUrl];
          if (spoke) {
            spoke.status = status;
            spoke.lastError = lastError ?? null;
          }
        });
      },

      reset: () => {
        set(() => ({ ...initialState }));
      },
    })),
    {
      name: STORAGE_KEY,
      version: 1,
      partialize: (state) => ({
        // Persist only credentials — exclude volatile status/lastError
        // (which trigger frequent writes) and serverIndex (derived on hydration).
        spokes: Object.fromEntries(
          Object.entries(state.spokes).map(([k, v]) => [
            k,
            {
              instanceUrl: v.instanceUrl,
              accessToken: v.accessToken,
              refreshToken: v.refreshToken,
              shadowUserId: v.shadowUserId,
              serverId: v.serverId,
            },
          ]),
        ),
      }),
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        // Reset volatile fields and rebuild derived index.
        for (const spoke of Object.values(state.spokes)) {
          spoke.status = 'disconnected';
          spoke.lastError = null;
        }
        state.serverIndex = buildServerIndex(state.spokes);
      },
    },
  ),
);
