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

/**
 * Synchronous fallback for reading the serverIndex when the persist middleware
 * hasn't finished async hydration yet (used by setServers guard).
 */
export function readFederatedServerIdsSync(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
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
        // Only persist spokes — serverIndex is derived on hydration.
        // Status and lastError are excluded via onRehydrateStorage below.
        spokes: state.spokes,
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
