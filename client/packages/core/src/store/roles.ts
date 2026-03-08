import type { Role } from '@meza/gen/meza/v1/models_pb.ts';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { HOME_INSTANCE } from '../gateway/gateway.ts';
import { reorderRoles as apiReorderRoles } from '../api/chat.ts';

export interface RoleState {
  /** Two-level nesting: byInstance[instanceUrl][serverId] = Role[] */
  byInstance: Record<string, Record<string, Role[]>>;
  /**
   * Backward-compatible mirror of byInstance[HOME_INSTANCE].
   * Kept in sync automatically.
   */
  byServer: Record<string, Role[]>;
  isLoading: boolean;
  isReordering: boolean;
  error: string | null;
}

export interface RoleActions {
  getByServer: (instanceUrl?: string) => Record<string, Role[]>;
  setRoles: (serverId: string, roles: Role[], instanceUrl?: string) => void;
  addRole: (role: Role, instanceUrl?: string) => void;
  updateRole: (role: Role, instanceUrl?: string) => void;
  removeRole: (
    serverId: string,
    roleId: string,
    instanceUrl?: string,
  ) => void;
  removeServerRoles: (serverId: string, instanceUrl?: string) => void;
  reorderRoles: (serverId: string, roleIds: string[]) => Promise<void>;
  removeInstanceData: (instanceUrl: string) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  reset: () => void;
}

/** Sync backward-compat property from byInstance[HOME_INSTANCE]. */
function syncCompat(state: RoleState) {
  state.byServer = state.byInstance[HOME_INSTANCE] ?? {};
}

export const useRoleStore = create<RoleState & RoleActions>()(
  immer((set, get) => ({
    byInstance: {},
    byServer: {},
    isLoading: false,
    isReordering: false,
    error: null,

    getByServer: (instanceUrl = HOME_INSTANCE) => {
      return get().byInstance[instanceUrl] ?? {};
    },

    setRoles: (serverId, roles, instanceUrl = HOME_INSTANCE) => {
      set((state) => {
        if (!state.byInstance[instanceUrl]) {
          state.byInstance[instanceUrl] = {};
        }
        state.byInstance[instanceUrl][serverId] = [...roles].sort(
          (a, b) => b.position - a.position,
        );
        state.isLoading = false;
        syncCompat(state);
      });
    },

    addRole: (role, instanceUrl = HOME_INSTANCE) => {
      set((state) => {
        if (!state.byInstance[instanceUrl]) {
          state.byInstance[instanceUrl] = {};
        }
        const bucket = state.byInstance[instanceUrl];
        const list = bucket[role.serverId] ?? [];
        if (list.some((r) => r.id === role.id)) return;
        list.push(role);
        list.sort((a, b) => b.position - a.position);
        bucket[role.serverId] = list;
        syncCompat(state);
      });
    },

    updateRole: (role, instanceUrl = HOME_INSTANCE) => {
      set((state) => {
        const bucket = state.byInstance[instanceUrl];
        if (!bucket) return;
        const list = bucket[role.serverId];
        if (!list) return;
        const idx = list.findIndex((r) => r.id === role.id);
        if (idx !== -1) {
          list[idx] = role;
          list.sort((a, b) => b.position - a.position);
        }
        syncCompat(state);
      });
    },

    removeRole: (serverId, roleId, instanceUrl = HOME_INSTANCE) => {
      set((state) => {
        const bucket = state.byInstance[instanceUrl];
        if (!bucket) return;
        const list = bucket[serverId];
        if (!list) return;
        bucket[serverId] = list.filter((r) => r.id !== roleId);
        syncCompat(state);
      });
    },

    removeServerRoles: (serverId, instanceUrl = HOME_INSTANCE) => {
      set((state) => {
        const bucket = state.byInstance[instanceUrl];
        if (!bucket) return;
        delete bucket[serverId];
        syncCompat(state);
      });
    },

    reorderRoles: async (serverId, roleIds) => {
      if (get().isReordering) return;
      // reorderRoles only works on home instance (API call is home-bound)
      const previous = get().byInstance[HOME_INSTANCE]?.[serverId];
      if (!previous) return;

      // Optimistically reorder: assign new positions based on roleIds order
      set((state) => {
        state.isReordering = true;
        const bucket = state.byInstance[HOME_INSTANCE];
        if (!bucket) return;
        const list = bucket[serverId];
        if (!list) return;

        // Build a map of roleId -> new position (higher index = lower position)
        // roleIds are ordered from highest position to lowest
        const positionMap = new Map<string, number>();
        for (let i = 0; i < roleIds.length; i++) {
          positionMap.set(roleIds[i], roleIds.length - i);
        }

        // Update positions for roles in the reorder list
        for (const role of list) {
          const newPos = positionMap.get(role.id);
          if (newPos !== undefined) {
            role.position = newPos;
          }
        }

        list.sort((a, b) => b.position - a.position);
        syncCompat(state);
      });

      try {
        await apiReorderRoles(serverId, roleIds);
      } catch {
        // Revert optimistic update by restoring previous state
        set((state) => {
          if (!state.byInstance[HOME_INSTANCE]) {
            state.byInstance[HOME_INSTANCE] = {};
          }
          state.byInstance[HOME_INSTANCE][serverId] = previous;
          syncCompat(state);
        });
      } finally {
        set((state) => {
          state.isReordering = false;
        });
      }
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
        state.isLoading = false;
        state.isReordering = false;
        state.error = null;
      });
    },
  })),
);
