import type { Role } from '@meza/gen/meza/v1/models_pb.ts';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { reorderRoles as apiReorderRoles } from '../api/chat.ts';

export interface RoleState {
  byServer: Record<string, Role[]>;
  isLoading: boolean;
  isReordering: boolean;
  error: string | null;
}

export interface RoleActions {
  setRoles: (serverId: string, roles: Role[]) => void;
  addRole: (role: Role) => void;
  updateRole: (role: Role) => void;
  removeRole: (serverId: string, roleId: string) => void;
  removeServerRoles: (serverId: string) => void;
  reorderRoles: (serverId: string, roleIds: string[]) => Promise<void>;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  reset: () => void;
}

export const useRoleStore = create<RoleState & RoleActions>()(
  immer((set, get) => ({
    byServer: {},
    isLoading: false,
    isReordering: false,
    error: null,

    setRoles: (serverId, roles) => {
      set((state) => {
        state.byServer[serverId] = [...roles].sort(
          (a, b) => b.position - a.position,
        );
        state.isLoading = false;
      });
    },

    addRole: (role) => {
      set((state) => {
        const list = state.byServer[role.serverId] ?? [];
        if (list.some((r) => r.id === role.id)) return;
        list.push(role);
        list.sort((a, b) => b.position - a.position);
        state.byServer[role.serverId] = list;
      });
    },

    updateRole: (role) => {
      set((state) => {
        const list = state.byServer[role.serverId];
        if (!list) return;
        const idx = list.findIndex((r) => r.id === role.id);
        if (idx !== -1) {
          list[idx] = role;
          list.sort((a, b) => b.position - a.position);
        }
      });
    },

    removeRole: (serverId, roleId) => {
      set((state) => {
        const list = state.byServer[serverId];
        if (!list) return;
        state.byServer[serverId] = list.filter((r) => r.id !== roleId);
      });
    },

    removeServerRoles: (serverId) => {
      set((state) => {
        delete state.byServer[serverId];
      });
    },

    reorderRoles: async (serverId, roleIds) => {
      if (get().isReordering) return;
      const previous = get().byServer[serverId];
      if (!previous) return;

      // Optimistically reorder: assign new positions based on roleIds order
      set((state) => {
        state.isReordering = true;
        const list = state.byServer[serverId];
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
      });

      try {
        await apiReorderRoles(serverId, roleIds);
      } catch {
        // Revert optimistic update by restoring previous state
        set((state) => {
          state.byServer[serverId] = previous;
        });
      } finally {
        set((state) => {
          state.isReordering = false;
        });
      }
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
        state.byServer = {};
        state.isLoading = false;
        state.isReordering = false;
        state.error = null;
      });
    },
  })),
);
