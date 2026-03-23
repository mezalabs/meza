import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

export interface VoiceChannelParticipant {
  userId: string;
  isMuted: boolean;
  isDeafened: boolean;
  isStreamingVideo: boolean;
  isEncrypted: boolean;
}

export interface VoiceParticipantsState {
  byChannel: Record<string, VoiceChannelParticipant[]>;
}

export interface VoiceParticipantsActions {
  setParticipants: (
    channelId: string,
    participants: VoiceChannelParticipant[],
  ) => void;
  upsertParticipant: (
    channelId: string,
    participant: VoiceChannelParticipant,
  ) => void;
  removeParticipant: (channelId: string, userId: string) => void;
  updateParticipant: (
    channelId: string,
    userId: string,
    patch: Partial<Omit<VoiceChannelParticipant, 'userId'>>,
  ) => void;
  clearChannel: (channelId: string) => void;
  clearAll: () => void;
}

export const useVoiceParticipantsStore = create<
  VoiceParticipantsState & VoiceParticipantsActions
>()(
  immer((set) => ({
    byChannel: {},

    setParticipants: (channelId, participants) => {
      set((state) => {
        state.byChannel[channelId] = participants;
      });
    },

    upsertParticipant: (channelId, participant) => {
      set((state) => {
        const list = state.byChannel[channelId];
        if (!list) {
          state.byChannel[channelId] = [participant];
          return;
        }
        const idx = list.findIndex((p) => p.userId === participant.userId);
        if (idx >= 0) {
          list[idx] = participant;
        } else {
          list.push(participant);
        }
      });
    },

    removeParticipant: (channelId, userId) => {
      set((state) => {
        const list = state.byChannel[channelId];
        if (!list) return;
        const idx = list.findIndex((p) => p.userId === userId);
        if (idx >= 0) list.splice(idx, 1);
      });
    },

    updateParticipant: (channelId, userId, patch) => {
      set((state) => {
        const list = state.byChannel[channelId];
        if (!list) return;
        const p = list.find((p) => p.userId === userId);
        if (p) Object.assign(p, patch);
      });
    },

    clearChannel: (channelId) => {
      set((state) => {
        delete state.byChannel[channelId];
      });
    },

    clearAll: () => {
      set((state) => {
        state.byChannel = {};
      });
    },
  })),
);
