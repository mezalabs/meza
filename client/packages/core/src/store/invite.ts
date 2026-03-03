import { create } from 'zustand';

const PENDING_INVITE_KEY = 'meza:pending_invite';
const INVITE_SECRET_KEY = 'meza:invite_secret';

export interface InviteState {
  pendingCode: string | null;
  inviteSecret: string | null; // base64url-encoded 32-byte secret from URL fragment
  setPendingCode: (code: string | null) => void;
  setInviteSecret: (secret: string | null) => void;
  clearPendingCode: () => void;
}

export const useInviteStore = create<InviteState>()((set) => ({
  pendingCode:
    typeof sessionStorage !== 'undefined'
      ? sessionStorage.getItem(PENDING_INVITE_KEY)
      : null,
  inviteSecret:
    typeof sessionStorage !== 'undefined'
      ? sessionStorage.getItem(INVITE_SECRET_KEY)
      : null,
  setPendingCode: (code) => {
    if (code) sessionStorage.setItem(PENDING_INVITE_KEY, code);
    else sessionStorage.removeItem(PENDING_INVITE_KEY);
    set({ pendingCode: code });
  },
  setInviteSecret: (secret) => {
    if (secret) sessionStorage.setItem(INVITE_SECRET_KEY, secret);
    else sessionStorage.removeItem(INVITE_SECRET_KEY);
    set({ inviteSecret: secret });
  },
  clearPendingCode: () => {
    sessionStorage.removeItem(PENDING_INVITE_KEY);
    sessionStorage.removeItem(INVITE_SECRET_KEY);
    set({ pendingCode: null, inviteSecret: null });
  },
}));
