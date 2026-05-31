import { create } from 'zustand';

/**
 * Drives the global "potentially dangerous download" confirmation.
 *
 * A download site that detects a risky file (see {@link isDangerousFile}) calls
 * `request()` with the filename and the action to run if the user proceeds. The
 * dialog — mounted once per shell, like the image viewer — renders off this
 * state and calls `confirm()` (runs the action) or `cancel()` (drops it).
 */
interface DangerousDownloadState {
  pending: { filename: string; onConfirm: () => void } | null;
  request: (filename: string, onConfirm: () => void) => void;
  confirm: () => void;
  cancel: () => void;
}

export const useDangerousDownloadStore = create<DangerousDownloadState>(
  (set, get) => ({
    pending: null,

    request: (filename, onConfirm) => set({ pending: { filename, onConfirm } }),

    confirm: () => {
      const { pending } = get();
      // Clear before running so a slow/throwing action can't leave the dialog
      // stuck open, and a re-entrant request() during onConfirm still works.
      set({ pending: null });
      pending?.onConfirm();
    },

    cancel: () => set({ pending: null }),
  }),
);
