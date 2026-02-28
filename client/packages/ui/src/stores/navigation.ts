import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

export interface NavigationState {
  selectedServerId: string | null;
  showDMs: boolean;
}

export interface NavigationActions {
  selectServer: (serverId: string) => void;
  selectDMs: () => void;
}

export const useNavigationStore = create<NavigationState & NavigationActions>()(
  immer((set) => ({
    selectedServerId: null,
    showDMs: false,

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
  })),
);
