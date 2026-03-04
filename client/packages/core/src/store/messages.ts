import type { LinkEmbed, Message } from '@meza/gen/meza/v1/models_pb.ts';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

export interface MessageState {
  byChannel: Record<string, Message[]>;
  /** Fast O(1) lookup by channelId then messageId. Subsumes the old dedup index. */
  byId: Record<string, Record<string, Message>>;
  hasMore: Record<string, boolean>;
  isLoading: Record<string, boolean>;
  error: Record<string, string>;
  /** 'live' = at conversation tail (default), 'historical' = viewing old messages after jump */
  viewMode: Record<string, 'live' | 'historical'>;
  /** Messages received while in historical mode, buffered until returnToPresent. */
  pendingMessages: Record<string, Message[]>;
  /** The message being replied to per channel, or null if not replying. */
  replyingTo: Record<string, Message | null>;
}

export interface MessageActions {
  setMessages: (channelId: string, messages: Message[]) => void;
  prependMessages: (channelId: string, messages: Message[]) => void;
  addMessage: (channelId: string, message: Message) => void;
  updateMessage: (channelId: string, message: Message) => void;
  bulkUpdateMessages: (channelId: string, messages: Message[]) => void;
  removeMessage: (channelId: string, messageId: string) => void;
  removeMessages: (channelId: string, messageIds: string[]) => void;
  setHasMore: (channelId: string, hasMore: boolean) => void;
  setLoading: (channelId: string, loading: boolean) => void;
  setError: (channelId: string, error: string | null) => void;
  setViewMode: (channelId: string, mode: 'live' | 'historical') => void;
  returnToPresent: (channelId: string) => void;
  patchEmbeds: (
    channelId: string,
    messageId: string,
    embeds: LinkEmbed[],
  ) => void;
  setReplyingTo: (channelId: string, message: Message | null) => void;
  reset: () => void;
}

/** Rebuild the byId index from an array of messages. */
function buildByIdIndex(messages: Message[]): Record<string, Message> {
  const index: Record<string, Message> = {};
  for (const m of messages) {
    index[m.id] = m;
  }
  return index;
}

export const useMessageStore = create<MessageState & MessageActions>()(
  immer((set) => ({
    byChannel: {},
    byId: {},
    hasMore: {},
    isLoading: {},
    error: {},
    viewMode: {},
    pendingMessages: {},
    replyingTo: {},

    setMessages: (channelId, messages) => {
      set((state) => {
        state.byChannel[channelId] = messages;
        state.byId[channelId] = buildByIdIndex(messages);
        delete state.isLoading[channelId];
      });
    },

    prependMessages: (channelId, messages) => {
      set((state) => {
        const existing = state.byChannel[channelId] ?? [];
        state.byChannel[channelId] = [...messages, ...existing];
        if (!state.byId[channelId]) {
          state.byId[channelId] = {};
        }
        const index = state.byId[channelId];
        if (index) {
          for (const m of messages) {
            index[m.id] = m;
          }
        }
        delete state.isLoading[channelId];
      });
    },

    addMessage: (channelId, message) => {
      set((state) => {
        // Buffer messages received while browsing history instead of dropping them
        if (state.viewMode[channelId] === 'historical') {
          // Dedup check against both live index and pending buffer
          if (state.byId[channelId]?.[message.id]) return;
          if (!state.pendingMessages[channelId]) {
            state.pendingMessages[channelId] = [];
          }
          const pending = state.pendingMessages[channelId];
          if (pending.some((m) => m.id === message.id)) return;
          pending.push(message);
          return;
        }
        // O(1) duplicate check
        if (state.byId[channelId]?.[message.id]) return;
        if (!state.byChannel[channelId]) {
          state.byChannel[channelId] = [];
        }
        const arr = state.byChannel[channelId];
        arr.push(message);
        // Trim from the front if over 500, removing evicted IDs from the index
        const excess = arr.length - 500;
        if (excess > 0) {
          const evicted = arr.splice(0, excess);
          const index = state.byId[channelId];
          if (index) {
            for (const m of evicted) {
              delete index[m.id];
            }
          }
        }
        // Index the new message
        if (!state.byId[channelId]) {
          state.byId[channelId] = {};
        }
        state.byId[channelId][message.id] = message;
      });
    },

    updateMessage: (channelId, message) => {
      set((state) => {
        const messages = state.byChannel[channelId];
        if (!messages) return;
        const idx = messages.findIndex((m) => m.id === message.id);
        if (idx === -1) return;
        state.byChannel[channelId][idx] = message;
        if (state.byId[channelId]) {
          state.byId[channelId][message.id] = message;
        }
      });
    },

    bulkUpdateMessages: (channelId, updates) => {
      set((state) => {
        const messages = state.byChannel[channelId];
        if (!messages) return;
        const updateMap = new Map(updates.map((m) => [m.id, m]));
        for (let i = 0; i < messages.length; i++) {
          const updated = updateMap.get(messages[i].id);
          if (updated) {
            state.byChannel[channelId][i] = updated;
            if (state.byId[channelId]) {
              state.byId[channelId][updated.id] = updated;
            }
          }
        }
      });
    },

    removeMessage: (channelId, messageId) => {
      set((state) => {
        const messages = state.byChannel[channelId];
        if (!messages) return;
        state.byChannel[channelId] = messages.filter((m) => m.id !== messageId);
        if (state.byId[channelId]) {
          delete state.byId[channelId][messageId];
        }
      });
    },

    removeMessages: (channelId, messageIds) => {
      set((state) => {
        const messages = state.byChannel[channelId];
        if (!messages) return;
        const idSet = new Set(messageIds);
        state.byChannel[channelId] = messages.filter((m) => !idSet.has(m.id));
        const index = state.byId[channelId];
        if (index) {
          for (const id of messageIds) {
            delete index[id];
          }
        }
      });
    },

    setHasMore: (channelId, hasMore) => {
      set((state) => {
        state.hasMore[channelId] = hasMore;
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

    setViewMode: (channelId, mode) => {
      set((state) => {
        state.viewMode[channelId] = mode;
      });
    },

    returnToPresent: (channelId) => {
      set((state) => {
        delete state.byChannel[channelId];
        delete state.byId[channelId];
        delete state.hasMore[channelId];
        delete state.viewMode[channelId];
        // Clear pending buffer — the re-fetch from getMessages will pick up
        // any messages that arrived while in historical mode.
        delete state.pendingMessages[channelId];
      });
    },

    patchEmbeds: (channelId, messageId, embeds) => {
      set((state) => {
        const messages = state.byChannel[channelId];
        if (!messages) return;
        const idx = messages.findIndex((m) => m.id === messageId);
        if (idx === -1) return;
        state.byChannel[channelId][idx].embeds = embeds;
        if (state.byId[channelId]?.[messageId]) {
          state.byId[channelId][messageId].embeds = embeds;
        }
      });
    },

    setReplyingTo: (channelId, message) => {
      set((state) => {
        if (message) {
          state.replyingTo[channelId] = message;
        } else {
          delete state.replyingTo[channelId];
        }
      });
    },

    reset: () => {
      set((state) => {
        state.byChannel = {};
        state.byId = {};
        state.hasMore = {};
        state.isLoading = {};
        state.error = {};
        state.viewMode = {};
        state.pendingMessages = {};
        state.replyingTo = {};
      });
    },
  })),
);
