import type { UpdateStatus } from '@meza/core';
import { create } from 'zustand';

interface UpdateState {
  status: UpdateStatus;
  lastMajorVersion: string | null;
}

interface UpdateActions {
  setStatus: (status: UpdateStatus) => void;
}

export const useUpdateStore = create<UpdateState & UpdateActions>(
  (set, get) => ({
    status: { state: 'idle' },
    lastMajorVersion: null,

    setStatus: (status) => {
      let lastMajorVersion = get().lastMajorVersion;

      if (
        status.state !== 'idle' &&
        status.state !== 'checking' &&
        status.state !== 'error' &&
        status.urgency === 'major'
      ) {
        lastMajorVersion = status.version;
      } else if (status.state === 'idle') {
        lastMajorVersion = null;
      }

      set({ status, lastMajorVersion });
    },
  }),
);

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
