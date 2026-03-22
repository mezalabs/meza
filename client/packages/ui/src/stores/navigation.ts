import type { PaneContent } from '@meza/core';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

export interface NavigationState {
  selectedServerId: string | null;
  showDMs: boolean;

  /** Mobile: the channel/DM currently shown in the slide-over (null = channel list visible) */
  mobileActiveChannel: PaneContent | null;
  /** Mobile: which overlay panel is open (null = none) */
  mobileOverlay: 'members' | 'pins' | 'search' | 'settings' | null;
  /** Mobile: whether the full-screen voice view is open */
  mobileVoiceFullscreen: boolean;
}

export interface NavigationActions {
  selectServer: (serverId: string) => void;
  selectDMs: () => void;

  openMobileChannel: (content: PaneContent) => void;
  closeMobileChannel: () => void;
  openMobileOverlay: (
    overlay: NonNullable<NavigationState['mobileOverlay']>,
  ) => void;
  closeMobileOverlay: () => void;
  openMobileVoice: () => void;
  closeMobileVoice: () => void;
  reset: () => void;
}

export const useNavigationStore = create<NavigationState & NavigationActions>()(
  immer((set) => ({
    selectedServerId: null,
    showDMs: false,
    mobileActiveChannel: null,
    mobileOverlay: null,
    mobileVoiceFullscreen: false,

    selectServer: (serverId) => {
      set((state) => {
        state.selectedServerId = serverId;
        state.showDMs = false;
      });
    },

    selectDMs: () => {
      set((state) => {
        state.selectedServerId = null;
        state.showDMs = true;
      });
    },

    openMobileChannel: (content) => {
      set((state) => {
        state.mobileActiveChannel = content;
      });
    },

    closeMobileChannel: () => {
      set((state) => {
        state.mobileActiveChannel = null;
      });
    },

    openMobileOverlay: (overlay) => {
      set((state) => {
        state.mobileOverlay = overlay;
      });
    },

    closeMobileOverlay: () => {
      set((state) => {
        state.mobileOverlay = null;
      });
    },

    openMobileVoice: () => {
      set((state) => {
        state.mobileVoiceFullscreen = true;
      });
    },

    closeMobileVoice: () => {
      set((state) => {
        state.mobileVoiceFullscreen = false;
      });
    },

    reset: () => {
      set((state) => {
        state.selectedServerId = null;
        state.showDMs = false;
        state.mobileActiveChannel = null;
        state.mobileOverlay = null;
        state.mobileVoiceFullscreen = false;
      });
    },
  })),
);
