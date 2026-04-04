import type { UpdateStatus } from '@meza/core';
import { create } from 'zustand';

interface UpdateState {
  status: UpdateStatus;
}

interface UpdateActions {
  setStatus: (status: UpdateStatus) => void;
}

export const useUpdateStore = create<UpdateState & UpdateActions>((set) => ({
  status: { state: 'idle' },

  setStatus: (status) => set({ status }),
}));

// ── IPC subscription (call once at app startup) ─────────────────────────

const unsubscribers: Array<() => void> = [];

export function initUpdateListeners(): void {
  // Clear previous subscriptions (HMR safety)
  for (const unsub of unsubscribers) unsub();
  unsubscribers.length = 0;

  const api = window.electronAPI?.updates;
  if (!api) return;

  unsubscribers.push(
    api.onStatus((status: UpdateStatus) => {
      useUpdateStore.getState().setStatus(status);
    }),
  );
}
