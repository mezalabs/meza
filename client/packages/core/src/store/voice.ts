import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

export type VoiceConnectionStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting';

export interface VoiceState {
  status: VoiceConnectionStatus;
  livekitUrl: string | null;
  livekitToken: string | null;
  channelId: string | null;
  channelName: string | null;
  canScreenShare: boolean;
  error: string | null;
}

export interface VoiceActions {
  setConnecting: (channelId: string, channelName: string) => void;
  setConnected: (url: string, token: string, canScreenShare: boolean) => void;
  setReconnecting: () => void;
  disconnect: () => void;
  setError: (error: string | null) => void;
}

const initialState: VoiceState = {
  status: 'idle',
  livekitUrl: null,
  livekitToken: null,
  channelId: null,
  channelName: null,
  canScreenShare: false,
  error: null,
};

export const useVoiceStore = create<VoiceState & VoiceActions>()(
  immer((set) => ({
    ...initialState,

    setConnecting: (channelId, channelName) => {
      set((state) => {
        state.status = 'connecting';
        state.channelId = channelId;
        state.channelName = channelName;
        state.livekitUrl = null;
        state.livekitToken = null;
        state.error = null;
      });
    },

    setConnected: (url, token, canScreenShare) => {
      set((state) => {
        state.status = 'connected';
        state.livekitUrl = url;
        state.livekitToken = token;
        state.canScreenShare = canScreenShare;
      });
    },

    setReconnecting: () => {
      set((state) => {
        state.status = 'reconnecting';
      });
    },

    disconnect: () => {
      set(() => ({ ...initialState }));
    },

    setError: (error) => {
      set(() => ({ ...initialState, error }));
    },
  })),
);
