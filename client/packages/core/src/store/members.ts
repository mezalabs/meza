import type { Member } from '@meza/gen/meza/v1/models_pb.ts';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { HOME_INSTANCE } from '../gateway/gateway.ts';

export interface MemberState {
  /** Two-level nesting: byInstance[instanceUrl][serverId] = Member[] */
  byInstance: Record<string, Record<string, Member[]>>;
  /**
   * Backward-compatible mirror of byInstance[HOME_INSTANCE].
   * Kept in sync automatically.
   */
  byServer: Record<string, Member[]>;
  isLoading: boolean;
  error: string | null;
}

export interface MemberActions {
  getByServer: (instanceUrl?: string) => Record<string, Member[]>;
  setMembers: (
    serverId: string,
    members: Member[],
    instanceUrl?: string,
  ) => void;
  addMember: (member: Member, instanceUrl?: string) => void;
  updateMember: (member: Member, instanceUrl?: string) => void;
  removeMember: (
    serverId: string,
    userId: string,
    instanceUrl?: string,
  ) => void;
  stripRoleFromAll: (
    serverId: string,
    roleId: string,
    instanceUrl?: string,
  ) => void;
  removeServerMembers: (serverId: string, instanceUrl?: string) => void;
  removeInstanceData: (instanceUrl: string) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  reset: () => void;
}

/** Sync backward-compat property from byInstance[HOME_INSTANCE]. */
function syncCompat(state: MemberState) {
  state.byServer = state.byInstance[HOME_INSTANCE] ?? {};
}

export const useMemberStore = create<MemberState & MemberActions>()(
  immer((set, get) => ({
    byInstance: {},
    byServer: {},
    isLoading: false,
    error: null,

    getByServer: (instanceUrl = HOME_INSTANCE) => {
      return get().byInstance[instanceUrl] ?? {};
    },

    setMembers: (serverId, members, instanceUrl = HOME_INSTANCE) => {
      set((state) => {
        if (!state.byInstance[instanceUrl]) {
          state.byInstance[instanceUrl] = {};
        }
        state.byInstance[instanceUrl][serverId] = members;
        state.isLoading = false;
        syncCompat(state);
      });
    },

    addMember: (member, instanceUrl = HOME_INSTANCE) => {
      set((state) => {
        if (!state.byInstance[instanceUrl]) {
          state.byInstance[instanceUrl] = {};
        }
        const bucket = state.byInstance[instanceUrl];
        const list = bucket[member.serverId] ?? [];
        // Avoid duplicates
        if (!list.some((m) => m.userId === member.userId)) {
          list.push(member);
          bucket[member.serverId] = list;
        }
        syncCompat(state);
      });
    },

    updateMember: (member, instanceUrl = HOME_INSTANCE) => {
      set((state) => {
        const bucket = state.byInstance[instanceUrl];
        if (!bucket) return;
        const list = bucket[member.serverId];
        if (!list) return;
        const idx = list.findIndex((m) => m.userId === member.userId);
        if (idx !== -1) {
          list[idx] = member;
        }
        syncCompat(state);
      });
    },

    removeMember: (serverId, userId, instanceUrl = HOME_INSTANCE) => {
      set((state) => {
        const bucket = state.byInstance[instanceUrl];
        if (!bucket) return;
        const list = bucket[serverId];
        if (!list) return;
        const idx = list.findIndex((m) => m.userId === userId);
        if (idx !== -1) {
          list.splice(idx, 1);
        }
        syncCompat(state);
      });
    },

    stripRoleFromAll: (serverId, roleId, instanceUrl = HOME_INSTANCE) => {
      set((state) => {
        const bucket = state.byInstance[instanceUrl];
        if (!bucket) return;
        const members = bucket[serverId];
        if (!members) return;
        for (const member of members) {
          const idx = member.roleIds.indexOf(roleId);
          if (idx !== -1) member.roleIds.splice(idx, 1);
        }
        syncCompat(state);
      });
    },

    removeServerMembers: (serverId, instanceUrl = HOME_INSTANCE) => {
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
        state.byServer = {};
        state.isLoading = false;
        state.error = null;
      });
    },
  })),
);
