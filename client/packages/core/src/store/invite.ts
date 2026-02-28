import { create } from 'zustand';

const PENDING_INVITE_KEY = 'meza:pending_invite';

export interface InviteState {
  pendingCode: string | null;
  setPendingCode: (code: string | null) => void;
  clearPendingCode: () => void;
}

export const useInviteStore = create<InviteState>()((set) => ({
  pendingCode:
    typeof sessionStorage !== 'undefined'
      ? sessionStorage.getItem(PENDING_INVITE_KEY)
      : null,
  setPendingCode: (code) => {
    if (code) sessionStorage.setItem(PENDING_INVITE_KEY, code);
    else sessionStorage.removeItem(PENDING_INVITE_KEY);
    set({ pendingCode: code });
  },
  clearPendingCode: () => {
    sessionStorage.removeItem(PENDING_INVITE_KEY);
    set({ pendingCode: null });
  },
}));
