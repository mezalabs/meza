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
  highlight: string;
  source: 'server' | 'local';
}

export interface SearchState {
  query: string;
  serverId: string;
  channelId: string;
  authorId: string;
  isLoading: boolean;
  results: SearchResultItem[];
  totalHits: number;
  error: string | null;

  setQuery: (query: string) => void;
  setServerId: (serverId: string) => void;
  setChannelId: (channelId: string) => void;
  setAuthorId: (authorId: string) => void;
  search: () => Promise<void>;
  reset: () => void;
}

export const useSearchStore = create<SearchState>()((set, get) => ({
  query: '',
  serverId: '',
  channelId: '',
  authorId: '',
  isLoading: false,
  results: [],
  totalHits: 0,
  error: null,

  setQuery: (query) => set({ query }),
  setServerId: (serverId) => set({ serverId }),
  setChannelId: (channelId) => set({ channelId }),
  setAuthorId: (authorId) => set({ authorId }),

  search: async () => {
    const { query, serverId, channelId, authorId } = get();
    if (!query.trim()) {
      set({ results: [], totalHits: 0, error: null });
      return;
    }

    set({ isLoading: true, error: null });

    try {
      // Server-side search (public channels via Meilisearch).
      const params: SearchMessagesParams = { query };
      if (serverId) params.serverId = serverId;
      if (channelId) params.channelId = channelId;
      if (authorId) params.authorId = authorId;

      const serverRes = await searchMessages(params);

      const serverResults: SearchResultItem[] = serverRes.results.map((r) => ({
        message: r.message ?? undefined,
        highlight: r.highlight,
        source: 'server' as const,
      }));

      // Client-side search (private channels via FlexSearch).
      const localHits = searchLocal(query, channelId || undefined);
      const localResults: SearchResultItem[] = localHits.map((r) => ({
        localResult: r,
        highlight: '',
        source: 'local' as const,
      }));

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
        totalHits: serverRes.totalHits + uniqueLocal.length,
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
      serverId: '',
      channelId: '',
      authorId: '',
      isLoading: false,
      results: [],
      totalHits: 0,
      error: null,
    }),
}));
