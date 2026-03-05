import type { Message } from '@meza/gen/meza/v1/models_pb.ts';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { type SearchMessagesParams, searchMessages } from '../api/chat.ts';
import {
  type DecryptedSearchResult,
  decryptSearchResults,
} from './decrypt-results.ts';
import { parseQuery } from './query-parser.ts';
import { searchIndex } from './search-service.ts';
import type { SearchHit } from './types.ts';

export interface SearchResultItem {
  message?: Message;
  localHit?: SearchHit;
  decryptedContent: string | null;
  source: 'server' | 'local';
}

function getResultTimestamp(r: SearchResultItem): number {
  if (r.message?.createdAt) return Number(r.message.createdAt.seconds) * 1000;
  if (r.localHit) return r.localHit.createdAt;
  return 0;
}

export interface SearchState {
  query: string;
  channelId: string;
  authorId: string;
  hasAttachment: boolean;
  scope: 'channel' | 'all';
  isLoading: boolean;
  results: SearchResultItem[];
  hasMore: boolean;
  error: string | null;
}

export interface SearchActions {
  setQuery: (query: string) => void;
  setChannelId: (channelId: string) => void;
  setAuthorId: (authorId: string) => void;
  setHasAttachment: (v: boolean) => void;
  setScope: (scope: 'channel' | 'all') => void;
  search: () => Promise<void>;
  reset: () => void;
}

// Generation counter + AbortController to prevent stale results
let searchGeneration = 0;
let activeAbort: AbortController | null = null;

export const useSearchStore = create<SearchState & SearchActions>()(
  immer((set, get) => ({
    query: '',
    channelId: '',
    authorId: '',
    hasAttachment: false,
    scope: 'channel',
    isLoading: false,
    results: [],
    hasMore: false,
    error: null,

    setQuery: (query) => {
      set((s) => {
        s.query = query;
      });
    },
    setChannelId: (channelId) => {
      set((s) => {
        s.channelId = channelId;
      });
    },
    setAuthorId: (authorId) => {
      set((s) => {
        s.authorId = authorId;
      });
    },
    setHasAttachment: (v) => {
      set((s) => {
        s.hasAttachment = v;
      });
    },
    setScope: (scope) => {
      set((s) => {
        s.scope = scope;
      });
    },

    search: async () => {
      const { query, channelId, authorId, hasAttachment, scope } = get();
      const parsed = parseQuery(query);

      if (!channelId && !parsed.text.trim()) {
        set((s) => {
          s.results = [];
          s.hasMore = false;
          s.error = null;
        });
        return;
      }

      // Cancel any in-flight search
      activeAbort?.abort();
      const controller = new AbortController();
      activeAbort = controller;
      const gen = ++searchGeneration;

      set((s) => {
        s.isLoading = true;
        s.error = null;
      });

      try {
        // Resolve from: filter to authorId
        const effectiveAuthorId = parsed.filters.from?.[0] ?? authorId;

        // --- Local search (FlexSearch worker) ---
        let localResults: SearchResultItem[] = [];
        if (parsed.text.trim()) {
          const localHits = await searchIndex(parsed.text, {
            channelId: scope === 'channel' ? channelId || undefined : undefined,
            authorId: effectiveAuthorId || undefined,
            hasAttachment: hasAttachment || undefined,
          });
          if (gen !== searchGeneration) return;

          localResults = localHits.map((hit) => ({
            localHit: hit,
            decryptedContent: null, // content fetched from message store by UI
            source: 'local' as const,
          }));
        }

        // --- Server-side metadata search (requires channelId) ---
        let serverResults: SearchResultItem[] = [];
        let hasMore = false;

        if (channelId && scope === 'channel') {
          const params: SearchMessagesParams = { channelId };
          if (effectiveAuthorId) params.authorId = effectiveAuthorId;
          if (hasAttachment) params.hasAttachment = true;

          const serverRes = await searchMessages(params);
          if (gen !== searchGeneration) return;

          hasMore = serverRes.hasMore;

          // Decrypt server results for display
          const decrypted = await decryptSearchResults(serverRes.messages);
          if (gen !== searchGeneration) return;

          serverResults = decrypted.map(
            (d: DecryptedSearchResult): SearchResultItem => ({
              message: d.message,
              decryptedContent: d.decryptedContent,
              source: 'server',
            }),
          );
        }

        // --- Deduplicate: local results take priority (have content) ---
        const localIds = new Set(
          localResults.map((r) => r.localHit?.id).filter(Boolean),
        );
        const uniqueServer = serverResults.filter(
          (r) => !localIds.has(r.message?.id),
        );

        // Sort combined results by timestamp (newest first)
        const combined = [...localResults, ...uniqueServer].sort(
          (a, b) => getResultTimestamp(b) - getResultTimestamp(a),
        );

        set((s) => {
          s.results = combined;
          s.hasMore = hasMore;
          s.isLoading = false;
        });
      } catch (err) {
        if (gen !== searchGeneration) return;
        if (err instanceof DOMException && err.name === 'AbortError') return;
        const msg = err instanceof Error ? err.message : 'Search failed';
        const isRateLimit = msg.includes('Limit reached') || msg.includes('rate limit');
        set((s) => {
          s.error = isRateLimit ? 'Search rate limited — please wait a few seconds' : msg;
          s.isLoading = false;
        });
      }
    },

    reset: () => {
      activeAbort?.abort();
      searchGeneration++;
      set((s) => {
        s.query = '';
        s.channelId = '';
        s.authorId = '';
        s.hasAttachment = false;
        s.scope = 'channel';
        s.isLoading = false;
        s.results = [];
        s.hasMore = false;
        s.error = null;
      });
    },
  })),
);
