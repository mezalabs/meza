import { create } from 'zustand';

const PENDING_INVITE_KEY = 'meza:pending_invite';
const PENDING_HOST_KEY = 'meza:pending_host';
const INVITE_SECRET_KEY = 'meza:invite_secret';

export interface InviteState {
  pendingCode: string | null;
  pendingHost: string | null; // instance domain from deep link (e.g. "coolgroup.org")
  inviteSecret: string | null; // base64url-encoded 32-byte secret from URL fragment
  /**
   * Monotonic counter incremented on every setPendingCode call. Lets
   * subscribers detect that the user re-clicked the same invite link, which
   * Zustand's default Object.is equality would otherwise hide.
   */
  pendingNonce: number;
  setPendingCode: (code: string | null) => void;
  setPendingHost: (host: string | null) => void;
  setInviteSecret: (secret: string | null) => void;
  clearPendingCode: () => void;
}

export const useInviteStore = create<InviteState>()((set) => ({
  pendingCode:
    typeof sessionStorage !== 'undefined'
      ? sessionStorage.getItem(PENDING_INVITE_KEY)
      : null,
  pendingHost:
    typeof sessionStorage !== 'undefined'
      ? sessionStorage.getItem(PENDING_HOST_KEY)
      : null,
  inviteSecret:
    typeof sessionStorage !== 'undefined'
      ? sessionStorage.getItem(INVITE_SECRET_KEY)
      : null,
  pendingNonce: 0,
  setPendingCode: (code) => {
    if (code) sessionStorage.setItem(PENDING_INVITE_KEY, code);
    else sessionStorage.removeItem(PENDING_INVITE_KEY);
    set((s) => ({ pendingCode: code, pendingNonce: s.pendingNonce + 1 }));
  },
  setPendingHost: (host) => {
    if (host) sessionStorage.setItem(PENDING_HOST_KEY, host);
    else sessionStorage.removeItem(PENDING_HOST_KEY);
    set({ pendingHost: host });
  },
  setInviteSecret: (secret) => {
    if (secret) sessionStorage.setItem(INVITE_SECRET_KEY, secret);
    else sessionStorage.removeItem(INVITE_SECRET_KEY);
    set({ inviteSecret: secret });
  },
  clearPendingCode: () => {
    sessionStorage.removeItem(PENDING_INVITE_KEY);
    sessionStorage.removeItem(PENDING_HOST_KEY);
    sessionStorage.removeItem(INVITE_SECRET_KEY);
    set({ pendingCode: null, pendingHost: null, inviteSecret: null });
  },
}));
