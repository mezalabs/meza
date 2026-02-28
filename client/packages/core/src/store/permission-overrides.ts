import type { PermissionOverride } from '@meza/gen/meza/v1/models_pb.ts';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

export interface PermissionOverrideState {
  byTarget: Record<string, PermissionOverride[]>;
  isLoading: Record<string, boolean>;
  error: string | null;
}

export interface PermissionOverrideActions {
  setOverrides: (targetId: string, overrides: PermissionOverride[]) => void;
  upsertOverride: (targetId: string, override: PermissionOverride) => void;
  removeOverride: (targetId: string, roleId: string, userId?: string) => void;
  setLoading: (targetId: string, loading: boolean) => void;
  setError: (error: string | null) => void;
  reset: () => void;
}

export const usePermissionOverrideStore = create<
  PermissionOverrideState & PermissionOverrideActions
>()(
  immer((set) => ({
    byTarget: {},
    isLoading: {},
    error: null,

    setOverrides: (targetId, overrides) => {
      set((state) => {
        state.byTarget[targetId] = overrides;
        state.isLoading[targetId] = false;
      });
    },

    upsertOverride: (targetId, override) => {
      set((state) => {
        const list = state.byTarget[targetId] ?? [];
        // Match on roleId for role overrides, userId for user overrides.
        const idx = override.userId
          ? list.findIndex((o) => o.userId === override.userId)
          : list.findIndex((o) => o.roleId === override.roleId);
        if (idx !== -1) {
          list[idx] = override;
        } else {
          list.push(override);
        }
        state.byTarget[targetId] = list;
      });
    },

    removeOverride: (targetId, roleId, userId) => {
      set((state) => {
        const list = state.byTarget[targetId];
        if (!list) return;
        if (userId) {
          state.byTarget[targetId] = list.filter((o) => o.userId !== userId);
        } else {
          state.byTarget[targetId] = list.filter((o) => o.roleId !== roleId);
        }
      });
    },

    setLoading: (targetId, loading) => {
      set((state) => {
        state.isLoading[targetId] = loading;
      });
    },

    setError: (error) => {
      set((state) => {
        state.error = error;
        state.isLoading = {};
      });
    },

    reset: () => {
      set((state) => {
        state.byTarget = {};
        state.isLoading = {};
        state.error = null;
      });
    },
  })),
);
