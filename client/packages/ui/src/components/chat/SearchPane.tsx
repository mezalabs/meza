import {
  type SearchResultItem,
  useChannelStore,
  useSearchStore,
  useServerStore,
} from '@meza/core';
import { MagnifyingGlassIcon, SpinnerGapIcon } from '@phosphor-icons/react';
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useDisplayName } from '../../hooks/useDisplayName.ts';
import { useNavigationStore } from '../../stores/navigation.ts';
import { useTilingStore } from '../../stores/tiling.ts';

const decoder = new TextDecoder();

interface SearchPaneProps {
  initialQuery?: string;
  serverId?: string;
  channelId?: string;
}

export function SearchPane({
  initialQuery,
  serverId,
  channelId,
}: SearchPaneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const query = useSearchStore((s) => s.query);
  const isLoading = useSearchStore((s) => s.isLoading);
  const results = useSearchStore((s) => s.results);
  const hasMore = useSearchStore((s) => s.hasMore);
  const error = useSearchStore((s) => s.error);

  const [localQuery, setLocalQuery] = useState(initialQuery ?? '');
  const navServerId = useNavigationStore((s) => s.selectedServerId);
  const selectedServerId = serverId ?? navServerId;
  const serverName = useServerStore((s) =>
    selectedServerId ? s.servers[selectedServerId]?.name : undefined,
  );

  // Hoist shared selectors so each SearchResultRow doesn't subscribe individually.
  const setPaneContent = useTilingStore((s) => s.setPaneContent);
  const focusedPaneId = useTilingStore((s) => s.focusedPaneId);

  // Build a channelId -> name map once instead of per-row .find() selectors.
  const channels = useChannelStore((s) =>
    selectedServerId ? s.byServer[selectedServerId] : undefined,
  );
  const channelNameMap = useMemo(() => {
    if (!channels) return new Map<string, string>();
    const map = new Map<string, string>();
    for (const c of channels) {
      map.set(c.id, c.name);
    }
    return map;
  }, [channels]);

  // Set channelId on the search store so server-side search is reachable.
  useEffect(() => {
    if (channelId) {
      useSearchStore.getState().setChannelId(channelId);
    }
  }, [channelId]);

  // Focus input on mount.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Reset on unmount.
  useEffect(() => {
    return () => {
      useSearchStore.getState().reset();
    };
  }, []);

  // Set initial query if provided.
  useEffect(() => {
    if (initialQuery) {
      setLocalQuery(initialQuery);
      const store = useSearchStore.getState();
      store.setQuery(initialQuery);
      store.search();
    }
  }, [initialQuery]);

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const store = useSearchStore.getState();
      store.setQuery(localQuery.trim());
      store.search();
    },
    [localQuery],
  );

  return (
    <div className="flex flex-col flex-1 min-h-0 min-w-0">
      {/* Search header */}
      <div className="px-4 py-3 border-b border-border bg-bg-secondary">
        <form onSubmit={handleSubmit} className="flex gap-2">
          <div className="relative flex-1">
            <MagnifyingGlassIcon
              className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-text-subtle"
              aria-hidden="true"
            />
            <input
              ref={inputRef}
              type="text"
              value={localQuery}
              onChange={(e) => setLocalQuery(e.target.value)}
              placeholder={
                serverName ? `Search in ${serverName}...` : 'Search messages...'
              }
              className="w-full pl-9 pr-3 py-1.5 bg-bg-tertiary border border-border rounded-md text-sm text-text-primary placeholder:text-text-subtle focus:outline-none focus:ring-1 focus:ring-accent"
            />
          </div>
        </form>
        {selectedServerId && serverName && (
          <div className="mt-1.5 text-xs text-text-subtle">
            Searching in{' '}
            <span className="font-medium text-text-secondary">
              {serverName}
            </span>
          </div>
        )}
      </div>

      {/* Results */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {isLoading && (
          <div className="flex items-center justify-center py-12 text-text-subtle text-sm">
            <SpinnerGapIcon
              className="animate-spin size-5 mr-2"
              aria-hidden="true"
            />
            Searching...
          </div>
        )}

        {error && (
          <div className="px-4 py-8 text-center text-sm text-red-400">
            {error}
          </div>
        )}

        {!isLoading && !error && query && results.length === 0 && (
          <div className="px-4 py-12 text-center text-sm text-text-subtle">
            No results found for &ldquo;{query}&rdquo;
          </div>
        )}

        {!isLoading && !error && !query && (
          <div className="px-4 py-12 text-center text-sm text-text-subtle">
            Type a query and press Enter to search
          </div>
        )}

        {results.length > 0 && (
          <div className="divide-y divide-border">
            {hasMore && (
              <div className="px-4 py-2 text-xs text-text-subtle bg-bg-secondary">
                More results available — refine your filters to narrow down
              </div>
            )}
            {results.map((result, i) => (
              <SearchResultRow
                key={result.message?.id ?? `local-${i}`}
                result={result}
                setPaneContent={setPaneContent}
                focusedPaneId={focusedPaneId}
                selectedServerId={selectedServerId}
                channelNameMap={channelNameMap}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

interface SearchResultRowProps {
  result: SearchResultItem;
  setPaneContent: (
    id: string,
    content: { type: 'channel'; channelId: string },
  ) => void;
  focusedPaneId: string;
  selectedServerId: string | null | undefined;
  channelNameMap: Map<string, string>;
}

const SearchResultRow = React.memo(function SearchResultRow({
  result,
  setPaneContent,
  focusedPaneId,
  selectedServerId,
  channelNameMap,
}: SearchResultRowProps) {
  const channelId =
    result.message?.channelId ?? result.localResult?.channelId ?? '';
  const authorId =
    result.message?.authorId ?? result.localResult?.authorId ?? '';

  const channelName = channelNameMap.get(channelId);

  const authorName = useDisplayName(authorId, selectedServerId ?? undefined);

  // For server results, show metadata only (content is E2EE encrypted).
  // For local results (already decrypted via FlexSearch), show plaintext.
  let content = '';
  const hasAttachments =
    result.message?.attachments && result.message.attachments.length > 0;
  if (result.source === 'server' && result.message) {
    content = hasAttachments ? 'Message with attachments' : 'Encrypted message';
  } else if (result.localResult) {
    content = result.localResult.content;
  }

  // Format timestamp.
  const timestamp = result.message?.createdAt
    ? new Date(
        Number(result.message.createdAt.seconds) * 1000,
      ).toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      })
    : result.localResult?.createdAt
      ? new Date(result.localResult.createdAt).toLocaleDateString(undefined, {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
        })
      : '';

  const handleClick = useCallback(() => {
    if (focusedPaneId && channelId) {
      setPaneContent(focusedPaneId, { type: 'channel', channelId });
    }
  }, [focusedPaneId, channelId, setPaneContent]);

  return (
    <button
      type="button"
      onClick={handleClick}
      className="w-full text-left px-4 py-3 hover:bg-bg-tertiary transition-colors cursor-pointer"
    >
      <div className="flex items-center gap-2 mb-1">
        <span className="text-xs font-semibold text-text-primary">
          {authorName}
        </span>
        {channelName && (
          <span className="text-xs text-text-subtle">#{channelName}</span>
        )}
        <span className="text-xs text-text-subtle ml-auto">{timestamp}</span>
      </div>
      <p className="text-sm text-text-secondary line-clamp-2">
        {result.source === 'server' ? (
          <span className="italic text-text-subtle">
            {content} — click to jump
          </span>
        ) : (
          content
        )}
      </p>
    </button>
  );
});
