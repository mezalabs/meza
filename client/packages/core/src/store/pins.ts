import type { PinnedMessage } from '@meza/gen/meza/v1/models_pb.ts';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

export interface PinState {
  byChannel: Record<string, PinnedMessage[]>;
  hasMore: Record<string, boolean>;
  isLoading: Record<string, boolean>;
  error: Record<string, string>;
  /** Map of pinned message IDs per channel for O(1) lookups in chat view */
  pinnedIds: Record<string, Record<string, true>>;
}

export interface PinActions {
  setPinnedMessages: (
    channelId: string,
    pins: PinnedMessage[],
    hasMore: boolean,
  ) => void;
  appendPinnedMessages: (
    channelId: string,
    pins: PinnedMessage[],
    hasMore: boolean,
  ) => void;
  addPin: (channelId: string, pin: PinnedMessage) => void;
  removePin: (channelId: string, messageId: string) => void;
  setLoading: (channelId: string, loading: boolean) => void;
  setError: (channelId: string, error: string | null) => void;
  reset: () => void;
}

function buildPinnedIds(pins: PinnedMessage[]): Record<string, true> {
  const record: Record<string, true> = {};
  for (const p of pins) {
    const id = p.message?.id;
    if (id) record[id] = true;
  }
  return record;
}

export const usePinStore = create<PinState & PinActions>()(
  immer((set) => ({
    byChannel: {},
    hasMore: {},
    isLoading: {},
    error: {},
    pinnedIds: {},

    setPinnedMessages: (channelId, pins, hasMore) => {
      set((state) => {
        state.byChannel[channelId] = pins;
        state.hasMore[channelId] = hasMore;
        state.pinnedIds[channelId] = buildPinnedIds(pins);
        delete state.isLoading[channelId];
      });
    },

    appendPinnedMessages: (channelId, pins, hasMore) => {
      set((state) => {
        const existing = state.byChannel[channelId] ?? [];
        const merged = [...existing, ...pins];
        state.byChannel[channelId] = merged;
        state.hasMore[channelId] = hasMore;
        state.pinnedIds[channelId] = buildPinnedIds(merged);
        delete state.isLoading[channelId];
      });
    },

    addPin: (channelId, pin) => {
      set((state) => {
        const existing = state.byChannel[channelId] ?? [];
        const msgId = pin.message?.id;
        if (msgId && existing.some((p) => p.message?.id === msgId)) return;
        state.byChannel[channelId] = [pin, ...existing];
        if (msgId) {
          if (!state.pinnedIds[channelId]) {
            state.pinnedIds[channelId] = {};
          }
          state.pinnedIds[channelId][msgId] = true;
        }
      });
    },

    removePin: (channelId, messageId) => {
      set((state) => {
        const existing = state.byChannel[channelId];
        if (!existing) return;
        state.byChannel[channelId] = existing.filter(
          (p) => p.message?.id !== messageId,
        );
        const ids = state.pinnedIds[channelId];
        if (ids) delete ids[messageId];
      });
    },

    setLoading: (channelId, loading) => {
      set((state) => {
        if (loading) {
          state.isLoading[channelId] = true;
        } else {
          delete state.isLoading[channelId];
        }
      });
    },

    setError: (channelId, error) => {
      set((state) => {
        if (error) {
          state.error[channelId] = error;
        } else {
          delete state.error[channelId];
        }
        delete state.isLoading[channelId];
      });
    },

    reset: () => {
      set((state) => {
        state.byChannel = {};
        state.hasMore = {};
        state.isLoading = {};
        state.error = {};
        state.pinnedIds = {};
      });
    },
  })),
);
