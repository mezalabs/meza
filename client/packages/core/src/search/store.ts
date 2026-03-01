import type { Message } from '@meza/gen/meza/v1/models_pb.ts';
import { create } from 'zustand';
import { type SearchMessagesParams, searchMessages } from '../api/chat.ts';
import { type LocalSearchResult, searchLocal } from './local-index.ts';

function getResultTimestamp(r: SearchResultItem): number {
  if (r.message?.createdAt) return Number(r.message.createdAt.seconds) * 1000;
  if (r.localResult) return r.localResult.createdAt;
  return 0;
}

export interface SearchResultItem {
  message?: Message;
  localResult?: LocalSearchResult;
  source: 'server' | 'local';
}

export interface SearchState {
  query: string;
  channelId: string;
  authorId: string;
  isLoading: boolean;
  results: SearchResultItem[];
  hasMore: boolean;
  error: string | null;

  setQuery: (query: string) => void;
  setChannelId: (channelId: string) => void;
  setAuthorId: (authorId: string) => void;
  search: () => Promise<void>;
  reset: () => void;
}

export const useSearchStore = create<SearchState>()((set, get) => ({
  query: '',
  channelId: '',
  authorId: '',
  isLoading: false,
  results: [],
  hasMore: false,
  error: null,

  setQuery: (query) => set({ query }),
  setChannelId: (channelId) => set({ channelId }),
  setAuthorId: (authorId) => set({ authorId }),

  search: async () => {
    const { query, channelId, authorId } = get();

    // Need at least a channel for server-side metadata search,
    // or a query for local FlexSearch.
    if (!channelId && !query.trim()) {
      set({ results: [], hasMore: false, error: null });
      return;
    }

    set({ isLoading: true, error: null });

    try {
      let serverResults: SearchResultItem[] = [];
      let hasMore = false;

      // Server-side metadata search (requires channelId).
      if (channelId) {
        const params: SearchMessagesParams = { channelId };
        if (authorId) params.authorId = authorId;

        const serverRes = await searchMessages(params);
        hasMore = serverRes.hasMore;

        serverResults = serverRes.messages.map((msg) => ({
          message: msg,
          source: 'server' as const,
        }));
      }

      // Client-side FlexSearch (decrypted content search).
      let localResults: SearchResultItem[] = [];
      if (query.trim()) {
        const localHits = searchLocal(query, channelId || undefined);
        localResults = localHits.map((r) => ({
          localResult: r,
          source: 'local' as const,
        }));
      }

      // Deduplicate: server results take priority.
      const serverIds = new Set(
        serverResults.map((r) => r.message?.id).filter(Boolean),
      );
      const uniqueLocal = localResults.filter(
        (r) => !serverIds.has(r.localResult?.id),
      );

      // Sort combined results by timestamp (newest first).
      const combined = [...serverResults, ...uniqueLocal].sort(
        (a, b) => getResultTimestamp(b) - getResultTimestamp(a),
      );

      set({
        results: combined,
        hasMore,
        isLoading: false,
      });
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : 'Search failed',
        isLoading: false,
      });
    }
  },

  reset: () =>
    set({
      query: '',
      channelId: '',
      authorId: '',
      isLoading: false,
      results: [],
      hasMore: false,
      error: null,
    }),
}));
