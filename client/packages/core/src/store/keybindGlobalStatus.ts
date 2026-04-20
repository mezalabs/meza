import { create } from 'zustand';
import type { KeybindGlobalStatus, KeybindId } from '../keybinds/keybinds.ts';

/**
 * Latest per-binding status reported by the Electron main process after a
 * `electronAPI.keybinds.sync` call. The renderer's `useKeybinds` hook owns
 * writing here; settings UI subscribes for the status pill.
 *
 * Empty in the web/mobile clients (electronAPI is undefined) and during
 * E2E runs (sync is gated by VITE_E2E).
 */
export interface KeybindGlobalStatusState {
  status: Partial<Record<KeybindId, KeybindGlobalStatus>>;
}

export interface KeybindGlobalStatusActions {
  setStatus: (status: Partial<Record<KeybindId, KeybindGlobalStatus>>) => void;
  clear: () => void;
}

export const useKeybindGlobalStatusStore = create<
  KeybindGlobalStatusState & KeybindGlobalStatusActions
>()((set) => ({
  status: {},
  setStatus: (status) => set({ status }),
  clear: () => set({ status: {} }),
}));
