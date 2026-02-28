import { PresenceStatus } from '@meza/gen/meza/v1/presence_pb.ts';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

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
  byUser: Record<string, UserPresence>;
  /** The local user's own presence status (for DND checks, etc.). */
  myStatus: PresenceStatus;
  /** Active status override (DND/Invisible/Offline with optional expiry). */
  myOverride: StatusOverride | null;
}

export interface PresenceActions {
  setPresence: (
    userId: string,
    status: PresenceStatus,
    statusText: string,
  ) => void;
  setMyStatus: (status: PresenceStatus) => void;
  setMyOverride: (override: StatusOverride | null) => void;
  setBulkPresence: (
    entries: { userId: string; status: PresenceStatus; statusText: string }[],
  ) => void;
  reset: () => void;
}

export const usePresenceStore = create<PresenceState & PresenceActions>()(
  immer((set) => ({
    byUser: {},
    myStatus: PresenceStatus.OFFLINE,
    myOverride: null,

    setPresence: (userId, status, statusText) => {
      set((state) => {
        state.byUser[userId] = { status, statusText, lastUpdated: Date.now() };
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

    setBulkPresence: (entries) => {
      set((state) => {
        for (const entry of entries) {
          state.byUser[entry.userId] = {
            status: entry.status,
            statusText: entry.statusText,
            lastUpdated: Date.now(),
          };
        }
      });
    },

    reset: () => {
      set((state) => {
        state.byUser = {};
        state.myStatus = PresenceStatus.OFFLINE;
        // myOverride intentionally NOT cleared — overrides persist across reconnects
      });
    },
  })),
);
