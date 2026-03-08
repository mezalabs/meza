import { PresenceStatus } from '@meza/gen/meza/v1/presence_pb.ts';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { HOME_INSTANCE } from '../gateway/gateway.ts';

export interface UserPresence {
  status: PresenceStatus;
  statusText: string;
  lastUpdated: number;
}

export interface StatusOverride {
  status: PresenceStatus;
  expiresAt: number;
}

export interface PresenceState {
  /** Per-instance presence: byInstance[instanceUrl][userId] = UserPresence */
  byInstance: Record<string, Record<string, UserPresence>>;
  /**
   * Backward-compatible mirror — merged presence across all instances.
   * A user is considered online if online on ANY instance (highest-priority wins).
   * Kept in sync automatically.
   */
  byUser: Record<string, UserPresence>;
  /** The local user's own presence status (for DND checks, etc.). */
  myStatus: PresenceStatus;
  /** Active status override (DND/Invisible/Offline with optional expiry). */
  myOverride: StatusOverride | null;
}

export interface PresenceActions {
  getByUser: (instanceUrl?: string) => Record<string, UserPresence>;
  /**
   * Get merged presence for a user across all instances.
   * Returns the "best" status (online > idle > dnd > offline).
   */
  getMergedPresence: (userId: string) => UserPresence | undefined;
  setPresence: (
    userId: string,
    status: PresenceStatus,
    statusText: string,
    instanceUrl?: string,
  ) => void;
  setMyStatus: (status: PresenceStatus) => void;
  setMyOverride: (override: StatusOverride | null) => void;
  setBulkPresence: (
    entries: { userId: string; status: PresenceStatus; statusText: string }[],
    instanceUrl?: string,
  ) => void;
  removeInstanceData: (instanceUrl: string) => void;
  reset: () => void;
}

/** Priority order: higher = more "present". */
function statusPriority(status: PresenceStatus): number {
  switch (status) {
    case PresenceStatus.ONLINE:
      return 4;
    case PresenceStatus.IDLE:
      return 3;
    case PresenceStatus.DND:
      return 2;
    case PresenceStatus.INVISIBLE:
      return 1;
    case PresenceStatus.OFFLINE:
    default:
      return 0;
  }
}

/** Rebuild merged byUser from all instances. */
function syncCompat(state: PresenceState) {
  const merged: Record<string, UserPresence> = {};
  for (const instanceData of Object.values(state.byInstance)) {
    for (const [userId, presence] of Object.entries(instanceData)) {
      const existing = merged[userId];
      if (
        !existing ||
        statusPriority(presence.status) > statusPriority(existing.status)
      ) {
        merged[userId] = presence;
      }
    }
  }
  state.byUser = merged;
}

export const usePresenceStore = create<PresenceState & PresenceActions>()(
  immer((set, get) => ({
    byInstance: {},
    byUser: {},
    myStatus: PresenceStatus.OFFLINE,
    myOverride: null,

    getByUser: (instanceUrl = HOME_INSTANCE) => {
      return get().byInstance[instanceUrl] ?? {};
    },

    getMergedPresence: (userId) => {
      const state = get();
      let best: UserPresence | undefined;
      for (const instanceData of Object.values(state.byInstance)) {
        const presence = instanceData[userId];
        if (
          presence &&
          (!best ||
            statusPriority(presence.status) > statusPriority(best.status))
        ) {
          best = presence;
        }
      }
      return best;
    },

    setPresence: (
      userId,
      status,
      statusText,
      instanceUrl = HOME_INSTANCE,
    ) => {
      set((state) => {
        if (!state.byInstance[instanceUrl]) {
          state.byInstance[instanceUrl] = {};
        }
        state.byInstance[instanceUrl][userId] = {
          status,
          statusText,
          lastUpdated: Date.now(),
        };
        syncCompat(state);
      });
    },

    setMyStatus: (status) => {
      set((state) => {
        state.myStatus = status;
      });
    },

    setMyOverride: (override) => {
      set((state) => {
        state.myOverride = override;
      });
    },

    setBulkPresence: (entries, instanceUrl = HOME_INSTANCE) => {
      set((state) => {
        if (!state.byInstance[instanceUrl]) {
          state.byInstance[instanceUrl] = {};
        }
        const bucket = state.byInstance[instanceUrl];
        for (const entry of entries) {
          bucket[entry.userId] = {
            status: entry.status,
            statusText: entry.statusText,
            lastUpdated: Date.now(),
          };
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

    reset: () => {
      set((state) => {
        state.byInstance = {};
        state.byUser = {};
        state.myStatus = PresenceStatus.OFFLINE;
        // myOverride intentionally NOT cleared — overrides persist across reconnects
      });
    },
  })),
);
