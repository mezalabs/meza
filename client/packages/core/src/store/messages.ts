import type { LinkEmbed, Message } from '@meza/gen/meza/v1/models_pb.ts';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { HOME_INSTANCE } from '../gateway/gateway.ts';

type InstanceBucket = {
  byChannel: Record<string, Message[]>;
  byId: Record<string, Record<string, Message>>;
  hasMore: Record<string, boolean>;
  isLoading: Record<string, boolean>;
  error: Record<string, string>;
  viewMode: Record<string, 'live' | 'historical'>;
  pendingMessages: Record<string, Message[]>;
  replyingTo: Record<string, Message | null>;
};

export interface MessageState {
  /** Two-level nesting: byInstance[instanceUrl] contains all per-channel maps */
  byInstance: Record<string, InstanceBucket>;
  /**
   * Backward-compatible mirrors of byInstance[HOME_INSTANCE].*
   * Kept in sync automatically.
   */
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
  getByChannel: (instanceUrl?: string) => Record<string, Message[]>;
  getById: (
    instanceUrl?: string,
  ) => Record<string, Record<string, Message>>;
  getHasMore: (instanceUrl?: string) => Record<string, boolean>;
  getIsLoading: (instanceUrl?: string) => Record<string, boolean>;
  getError: (instanceUrl?: string) => Record<string, string>;
  getViewMode: (
    instanceUrl?: string,
  ) => Record<string, 'live' | 'historical'>;
  getPendingMessages: (instanceUrl?: string) => Record<string, Message[]>;
  getReplyingTo: (
    instanceUrl?: string,
  ) => Record<string, Message | null>;
  setMessages: (
    channelId: string,
    messages: Message[],
    instanceUrl?: string,
  ) => void;
  prependMessages: (
    channelId: string,
    messages: Message[],
    instanceUrl?: string,
  ) => void;
  addMessage: (
    channelId: string,
    message: Message,
    instanceUrl?: string,
  ) => void;
  updateMessage: (
    channelId: string,
    message: Message,
    instanceUrl?: string,
  ) => void;
  bulkUpdateMessages: (
    channelId: string,
    messages: Message[],
    instanceUrl?: string,
  ) => void;
  removeMessage: (
    channelId: string,
    messageId: string,
    instanceUrl?: string,
  ) => void;
  removeMessages: (
    channelId: string,
    messageIds: string[],
    instanceUrl?: string,
  ) => void;
  setHasMore: (
    channelId: string,
    hasMore: boolean,
    instanceUrl?: string,
  ) => void;
  setLoading: (
    channelId: string,
    loading: boolean,
    instanceUrl?: string,
  ) => void;
  setError: (
    channelId: string,
    error: string | null,
    instanceUrl?: string,
  ) => void;
  setViewMode: (
    channelId: string,
    mode: 'live' | 'historical',
    instanceUrl?: string,
  ) => void;
  returnToPresent: (channelId: string, instanceUrl?: string) => void;
  patchEmbeds: (
    channelId: string,
    messageId: string,
    embeds: LinkEmbed[],
    instanceUrl?: string,
  ) => void;
  setReplyingTo: (
    channelId: string,
    message: Message | null,
    instanceUrl?: string,
  ) => void;
  removeInstanceData: (instanceUrl: string) => void;
  reset: () => void;
}

function emptyBucket(): InstanceBucket {
  return {
    byChannel: {},
    byId: {},
    hasMore: {},
    isLoading: {},
    error: {},
    viewMode: {},
    pendingMessages: {},
    replyingTo: {},
  };
}

function ensureBucket(
  state: { byInstance: Record<string, InstanceBucket> },
  instanceUrl: string,
): InstanceBucket {
  if (!state.byInstance[instanceUrl]) {
    state.byInstance[instanceUrl] = emptyBucket();
  }
  return state.byInstance[instanceUrl];
}

/** Rebuild the byId index from an array of messages. */
function buildByIdIndex(messages: Message[]): Record<string, Message> {
  const index: Record<string, Message> = {};
  for (const m of messages) {
    index[m.id] = m;
  }
  return index;
}

/** Sync backward-compat properties from byInstance[HOME_INSTANCE]. */
function syncCompat(state: MessageState) {
  const home = state.byInstance[HOME_INSTANCE];
  if (home) {
    state.byChannel = home.byChannel;
    state.byId = home.byId;
    state.hasMore = home.hasMore;
    state.isLoading = home.isLoading;
    state.error = home.error;
    state.viewMode = home.viewMode;
    state.pendingMessages = home.pendingMessages;
    state.replyingTo = home.replyingTo;
  } else {
    state.byChannel = {};
    state.byId = {};
    state.hasMore = {};
    state.isLoading = {};
    state.error = {};
    state.viewMode = {};
    state.pendingMessages = {};
    state.replyingTo = {};
  }
}

export const useMessageStore = create<MessageState & MessageActions>()(
  immer((set, get) => ({
    byInstance: {},
    byChannel: {},
    byId: {},
    hasMore: {},
    isLoading: {},
    error: {},
    viewMode: {},
    pendingMessages: {},
    replyingTo: {},

    getByChannel: (instanceUrl = HOME_INSTANCE) =>
      get().byInstance[instanceUrl]?.byChannel ?? {},
    getById: (instanceUrl = HOME_INSTANCE) =>
      get().byInstance[instanceUrl]?.byId ?? {},
    getHasMore: (instanceUrl = HOME_INSTANCE) =>
      get().byInstance[instanceUrl]?.hasMore ?? {},
    getIsLoading: (instanceUrl = HOME_INSTANCE) =>
      get().byInstance[instanceUrl]?.isLoading ?? {},
    getError: (instanceUrl = HOME_INSTANCE) =>
      get().byInstance[instanceUrl]?.error ?? {},
    getViewMode: (instanceUrl = HOME_INSTANCE) =>
      get().byInstance[instanceUrl]?.viewMode ?? {},
    getPendingMessages: (instanceUrl = HOME_INSTANCE) =>
      get().byInstance[instanceUrl]?.pendingMessages ?? {},
    getReplyingTo: (instanceUrl = HOME_INSTANCE) =>
      get().byInstance[instanceUrl]?.replyingTo ?? {},

    setMessages: (channelId, messages, instanceUrl = HOME_INSTANCE) => {
      set((state) => {
        const bucket = ensureBucket(state, instanceUrl);
        bucket.byChannel[channelId] = messages;
        bucket.byId[channelId] = buildByIdIndex(messages);
        delete bucket.isLoading[channelId];
        syncCompat(state);
      });
    },

    prependMessages: (channelId, messages, instanceUrl = HOME_INSTANCE) => {
      set((state) => {
        const bucket = ensureBucket(state, instanceUrl);
        const existing = bucket.byChannel[channelId] ?? [];
        bucket.byChannel[channelId] = [...messages, ...existing];
        if (!bucket.byId[channelId]) {
          bucket.byId[channelId] = {};
        }
        const index = bucket.byId[channelId];
        if (index) {
          for (const m of messages) {
            index[m.id] = m;
          }
        }
        delete bucket.isLoading[channelId];
        syncCompat(state);
      });
    },

    addMessage: (channelId, message, instanceUrl = HOME_INSTANCE) => {
      set((state) => {
        const bucket = ensureBucket(state, instanceUrl);
        // Buffer messages received while browsing history instead of dropping them
        if (bucket.viewMode[channelId] === 'historical') {
          // Dedup check against both live index and pending buffer
          if (bucket.byId[channelId]?.[message.id]) return;
          if (!bucket.pendingMessages[channelId]) {
            bucket.pendingMessages[channelId] = [];
          }
          const pending = bucket.pendingMessages[channelId];
          if (pending.some((m) => m.id === message.id)) return;
          pending.push(message);
          syncCompat(state);
          return;
        }
        // O(1) duplicate check
        if (bucket.byId[channelId]?.[message.id]) return;
        if (!bucket.byChannel[channelId]) {
          bucket.byChannel[channelId] = [];
        }
        const arr = bucket.byChannel[channelId];
        arr.push(message);
        // Trim from the front if over 500, removing evicted IDs from the index
        const excess = arr.length - 500;
        if (excess > 0) {
          const evicted = arr.splice(0, excess);
          const index = bucket.byId[channelId];
          if (index) {
            for (const m of evicted) {
              delete index[m.id];
            }
          }
        }
        // Index the new message
        if (!bucket.byId[channelId]) {
          bucket.byId[channelId] = {};
        }
        bucket.byId[channelId][message.id] = message;
        syncCompat(state);
      });
    },

    updateMessage: (channelId, message, instanceUrl = HOME_INSTANCE) => {
      set((state) => {
        const bucket = state.byInstance[instanceUrl];
        if (!bucket) return;
        const messages = bucket.byChannel[channelId];
        if (!messages) return;
        const idx = messages.findIndex((m) => m.id === message.id);
        if (idx === -1) return;
        bucket.byChannel[channelId][idx] = message;
        if (bucket.byId[channelId]) {
          bucket.byId[channelId][message.id] = message;
        }
        syncCompat(state);
      });
    },

    bulkUpdateMessages: (channelId, updates, instanceUrl = HOME_INSTANCE) => {
      set((state) => {
        const bucket = state.byInstance[instanceUrl];
        if (!bucket) return;
        const messages = bucket.byChannel[channelId];
        if (!messages) return;
        const updateMap = new Map(updates.map((m) => [m.id, m]));
        for (let i = 0; i < messages.length; i++) {
          const updated = updateMap.get(messages[i].id);
          if (updated) {
            bucket.byChannel[channelId][i] = updated;
            if (bucket.byId[channelId]) {
              bucket.byId[channelId][updated.id] = updated;
            }
          }
        }
        syncCompat(state);
      });
    },

    removeMessage: (channelId, messageId, instanceUrl = HOME_INSTANCE) => {
      set((state) => {
        const bucket = state.byInstance[instanceUrl];
        if (!bucket) return;
        const messages = bucket.byChannel[channelId];
        if (!messages) return;
        bucket.byChannel[channelId] = messages.filter(
          (m) => m.id !== messageId,
        );
        if (bucket.byId[channelId]) {
          delete bucket.byId[channelId][messageId];
        }
        syncCompat(state);
      });
    },

    removeMessages: (channelId, messageIds, instanceUrl = HOME_INSTANCE) => {
      set((state) => {
        const bucket = state.byInstance[instanceUrl];
        if (!bucket) return;
        const messages = bucket.byChannel[channelId];
        if (!messages) return;
        const idSet = new Set(messageIds);
        bucket.byChannel[channelId] = messages.filter(
          (m) => !idSet.has(m.id),
        );
        const index = bucket.byId[channelId];
        if (index) {
          for (const id of messageIds) {
            delete index[id];
          }
        }
        syncCompat(state);
      });
    },

    setHasMore: (channelId, hasMore, instanceUrl = HOME_INSTANCE) => {
      set((state) => {
        const bucket = ensureBucket(state, instanceUrl);
        bucket.hasMore[channelId] = hasMore;
        syncCompat(state);
      });
    },

    setLoading: (channelId, loading, instanceUrl = HOME_INSTANCE) => {
      set((state) => {
        const bucket = ensureBucket(state, instanceUrl);
        if (loading) {
          bucket.isLoading[channelId] = true;
        } else {
          delete bucket.isLoading[channelId];
        }
        syncCompat(state);
      });
    },

    setError: (channelId, error, instanceUrl = HOME_INSTANCE) => {
      set((state) => {
        const bucket = ensureBucket(state, instanceUrl);
        if (error) {
          bucket.error[channelId] = error;
        } else {
          delete bucket.error[channelId];
        }
        delete bucket.isLoading[channelId];
        syncCompat(state);
      });
    },

    setViewMode: (channelId, mode, instanceUrl = HOME_INSTANCE) => {
      set((state) => {
        const bucket = ensureBucket(state, instanceUrl);
        bucket.viewMode[channelId] = mode;
        syncCompat(state);
      });
    },

    returnToPresent: (channelId, instanceUrl = HOME_INSTANCE) => {
      set((state) => {
        const bucket = state.byInstance[instanceUrl];
        if (!bucket) return;
        delete bucket.byChannel[channelId];
        delete bucket.byId[channelId];
        delete bucket.hasMore[channelId];
        delete bucket.viewMode[channelId];
        // Clear pending buffer — the re-fetch from getMessages will pick up
        // any messages that arrived while in historical mode.
        delete bucket.pendingMessages[channelId];
        syncCompat(state);
      });
    },

    patchEmbeds: (
      channelId,
      messageId,
      embeds,
      instanceUrl = HOME_INSTANCE,
    ) => {
      set((state) => {
        const bucket = state.byInstance[instanceUrl];
        if (!bucket) return;
        const messages = bucket.byChannel[channelId];
        if (!messages) return;
        const idx = messages.findIndex((m) => m.id === messageId);
        if (idx === -1) return;
        bucket.byChannel[channelId][idx].embeds = embeds;
        if (bucket.byId[channelId]?.[messageId]) {
          bucket.byId[channelId][messageId].embeds = embeds;
        }
        syncCompat(state);
      });
    },

    setReplyingTo: (channelId, message, instanceUrl = HOME_INSTANCE) => {
      set((state) => {
        const bucket = ensureBucket(state, instanceUrl);
        if (message) {
          bucket.replyingTo[channelId] = message;
        } else {
          delete bucket.replyingTo[channelId];
        }
        syncCompat(state);
      });
    },

    removeInstanceData: (instanceUrl) => {
      set((state) => {
        delete state.byInstance[instanceUrl];
        syncCompat(state);
      });
    },

    reset: () => {
      set((state) => {
        state.byInstance = {};
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
