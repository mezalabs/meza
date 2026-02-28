import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

export type GatewayStatus =
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'reconnecting';

export interface GatewayState {
  status: GatewayStatus;
  reconnectAttempt: number;
  reconnectCount: number;
  lastError: string | null;
  /**
   * Channel IDs the user is currently viewing. Updated by the UI layer
   * so the gateway can skip unread increments for focused channels.
   */
  viewedChannelIds: Record<string, true>;
}

export interface GatewayActions {
  setStatus: (status: GatewayStatus) => void;
  setReconnectAttempt: (attempt: number) => void;
  incrementReconnectCount: () => void;
  setLastError: (error: string | null) => void;
  addViewedChannel: (channelId: string) => void;
  removeViewedChannel: (channelId: string) => void;
  reset: () => void;
}

export const useGatewayStore = create<GatewayState & GatewayActions>()(
  immer((set) => ({
    status: 'disconnected',
    reconnectAttempt: 0,
    reconnectCount: 0,
    lastError: null,
    viewedChannelIds: {},

    setStatus: (status) => {
      set((state) => {
        state.status = status;
      });
    },

    setReconnectAttempt: (attempt) => {
      set((state) => {
        state.reconnectAttempt = attempt;
      });
    },

    incrementReconnectCount: () => {
      set((state) => {
        state.reconnectCount++;
      });
    },

    setLastError: (error) => {
      set((state) => {
        state.lastError = error;
      });
    },

    addViewedChannel: (channelId) => {
      set((state) => {
        state.viewedChannelIds[channelId] = true;
      });
    },

    removeViewedChannel: (channelId) => {
      set((state) => {
        delete state.viewedChannelIds[channelId];
      });
    },

    reset: () => {
      set((state) => {
        state.status = 'disconnected';
        state.reconnectAttempt = 0;
        state.reconnectCount = 0;
        state.lastError = null;
        state.viewedChannelIds = {};
      });
    },
  })),
);
