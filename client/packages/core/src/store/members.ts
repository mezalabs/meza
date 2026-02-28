import type { Member } from '@meza/gen/meza/v1/models_pb.ts';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

export interface MemberState {
  byServer: Record<string, Member[]>;
  isLoading: boolean;
  error: string | null;
}

export interface MemberActions {
  setMembers: (serverId: string, members: Member[]) => void;
  addMember: (member: Member) => void;
  updateMember: (member: Member) => void;
  removeMember: (serverId: string, userId: string) => void;
  stripRoleFromAll: (serverId: string, roleId: string) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  reset: () => void;
}

export const useMemberStore = create<MemberState & MemberActions>()(
  immer((set) => ({
    byServer: {},
    isLoading: false,
    error: null,

    setMembers: (serverId, members) => {
      set((state) => {
        state.byServer[serverId] = members;
        state.isLoading = false;
      });
    },

    addMember: (member) => {
      set((state) => {
        const list = state.byServer[member.serverId] ?? [];
        // Avoid duplicates
        if (!list.some((m) => m.userId === member.userId)) {
          list.push(member);
          state.byServer[member.serverId] = list;
        }
      });
    },

    updateMember: (member) => {
      set((state) => {
        const list = state.byServer[member.serverId];
        if (!list) return;
        const idx = list.findIndex((m) => m.userId === member.userId);
        if (idx !== -1) {
          list[idx] = member;
        }
      });
    },

    removeMember: (serverId, userId) => {
      set((state) => {
        const list = state.byServer[serverId];
        if (!list) return;
        const idx = list.findIndex((m) => m.userId === userId);
        if (idx !== -1) {
          list.splice(idx, 1);
        }
      });
    },

    stripRoleFromAll: (serverId, roleId) => {
      set((state) => {
        const members = state.byServer[serverId];
        if (!members) return;
        for (const member of members) {
          const idx = member.roleIds.indexOf(roleId);
          if (idx !== -1) member.roleIds.splice(idx, 1);
        }
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
        state.byServer = {};
        state.isLoading = false;
        state.error = null;
      });
    },
  })),
);
