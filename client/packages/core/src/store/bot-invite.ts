import { create } from 'zustand';

const PENDING_BOT_INVITE_KEY = 'meza:pending_bot_invite';

export interface BotInviteState {
  pendingCode: string | null;
  setPendingCode: (code: string | null) => void;
  clearPendingCode: () => void;
}

export const useBotInviteStore = create<BotInviteState>()((set) => ({
  pendingCode:
    typeof sessionStorage !== 'undefined'
      ? sessionStorage.getItem(PENDING_BOT_INVITE_KEY)
      : null,
  setPendingCode: (code) => {
    if (code) sessionStorage.setItem(PENDING_BOT_INVITE_KEY, code);
    else sessionStorage.removeItem(PENDING_BOT_INVITE_KEY);
    set({ pendingCode: code });
  },
  clearPendingCode: () => {
    sessionStorage.removeItem(PENDING_BOT_INVITE_KEY);
    set({ pendingCode: null });
  },
}));
