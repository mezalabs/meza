import type { DMChannel, User } from '@meza/gen/meza/v1/models_pb.ts';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

export interface DMState {
  dmChannels: DMChannel[];
  messageRequests: DMChannel[];
  isLoading: boolean;
  error: string | null;
}

export interface DMActions {
  setDMChannels: (channels: DMChannel[]) => void;
  addOrUpdateDMChannel: (channel: DMChannel) => void;
  removeDMChannel: (channelId: string) => void;
  addDMChannelParticipant: (channelId: string, user: User) => void;
  removeDMChannelParticipant: (channelId: string, userId: string) => void;
  setMessageRequests: (channels: DMChannel[]) => void;
  addMessageRequest: (channel: DMChannel) => void;
  removeMessageRequest: (channelId: string) => void;
  moveRequestToActive: (channelId: string) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  reset: () => void;
}

export const useDMStore = create<DMState & DMActions>()(
  immer((set) => ({
    dmChannels: [],
    messageRequests: [],
    isLoading: false,
    error: null,

    setDMChannels: (channels) => {
      set((state) => {
        state.dmChannels = channels;
        state.isLoading = false;
      });
    },

    addOrUpdateDMChannel: (channel) => {
      set((state) => {
        const idx = state.dmChannels.findIndex(
          (c) => c.channel?.id === channel.channel?.id,
        );
        if (idx !== -1) {
          state.dmChannels[idx] = channel;
        } else {
          state.dmChannels.unshift(channel);
        }
      });
    },

    removeDMChannel: (channelId) => {
      set((state) => {
        state.dmChannels = state.dmChannels.filter(
          (c) => c.channel?.id !== channelId,
        );
      });
    },

    addDMChannelParticipant: (channelId, user) => {
      set((state) => {
        const dm = state.dmChannels.find((c) => c.channel?.id === channelId);
        if (dm && !dm.participants.some((p) => p.id === user.id)) {
          dm.participants.push(user);
        }
      });
    },

    removeDMChannelParticipant: (channelId, userId) => {
      set((state) => {
        const dm = state.dmChannels.find((c) => c.channel?.id === channelId);
        if (dm) {
          dm.participants = dm.participants.filter((p) => p.id !== userId);
        }
      });
    },

    setMessageRequests: (channels) => {
      set((state) => {
        state.messageRequests = channels;
      });
    },

    addMessageRequest: (channel) => {
      set((state) => {
        const idx = state.messageRequests.findIndex(
          (c) => c.channel?.id === channel.channel?.id,
        );
        if (idx === -1) {
          state.messageRequests.unshift(channel);
        }
      });
    },

    removeMessageRequest: (channelId) => {
      set((state) => {
        state.messageRequests = state.messageRequests.filter(
          (c) => c.channel?.id !== channelId,
        );
      });
    },

    moveRequestToActive: (channelId) => {
      set((state) => {
        const request = state.messageRequests.find(
          (c) => c.channel?.id === channelId,
        );
        if (request) {
          state.messageRequests = state.messageRequests.filter(
            (c) => c.channel?.id !== channelId,
          );
          state.dmChannels.unshift(request);
        }
      });
    },

    setLoading: (loading) => {
      set((state) => {
        state.isLoading = loading;
      });
    },

    setError: (error) => {
      set((state) => {
        state.error = error;
        state.isLoading = false;
      });
    },

    reset: () => {
      set((state) => {
        state.dmChannels = [];
        state.messageRequests = [];
        state.isLoading = false;
        state.error = null;
      });
    },
  })),
);
