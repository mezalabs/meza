import {
  getMessages,
  parseMessageContent,
  type SearchResultItem,
  useChannelStore,
  useMemberStore,
  useMessageStore,
  useSearchStore,
  useServerStore,
} from '@meza/core';
import {
  FunnelIcon,
  MagnifyingGlassIcon,
  PaperclipIcon,
  SpinnerGapIcon,
} from '@phosphor-icons/react';
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
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(null);
  const query = useSearchStore((s) => s.query);
  const isLoading = useSearchStore((s) => s.isLoading);
  const results = useSearchStore((s) => s.results);
  const hasMore = useSearchStore((s) => s.hasMore);
  const error = useSearchStore((s) => s.error);
  const scope = useSearchStore((s) => s.scope);
  const hasAttachment = useSearchStore((s) => s.hasAttachment);

  const [localQuery, setLocalQuery] = useState(initialQuery ?? '');
  const [showFilters, setShowFilters] = useState(false);
  const navServerId = useNavigationStore((s) => s.selectedServerId);
  const selectedServerId = serverId ?? navServerId;
  const serverName = useServerStore((s) =>
    selectedServerId ? s.servers[selectedServerId]?.name : undefined,
  );

  // Hoist shared selectors
  const setPaneContent = useTilingStore((s) => s.setPaneContent);
  const focusedPaneId = useTilingStore((s) => s.focusedPaneId);

  // Build channelId -> name map
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

  // Members for author filter dropdown
  const members = useMemberStore((s) =>
    selectedServerId ? s.byServer[selectedServerId] : undefined,
  );

  // Set channelId on the search store
  useEffect(() => {
    if (channelId) {
      useSearchStore.getState().setChannelId(channelId);
    }
  }, [channelId]);

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      useSearchStore.getState().reset();
    };
  }, []);

  // Set initial query if provided
  useEffect(() => {
    if (initialQuery) {
      setLocalQuery(initialQuery);
      const store = useSearchStore.getState();
      store.setQuery(initialQuery);
      store.search();
    }
  }, [initialQuery]);

  // Debounced as-you-type search
  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = e.target.value;
      setLocalQuery(value);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        const store = useSearchStore.getState();
        store.setQuery(value.trim());
        if (value.trim()) {
          store.search();
        }
      }, 150);
    },
    [],
  );

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      if (debounceRef.current) clearTimeout(debounceRef.current);
      const store = useSearchStore.getState();
      store.setQuery(localQuery.trim());
      store.search();
    },
    [localQuery],
  );

  const handleScopeToggle = useCallback((newScope: 'channel' | 'all') => {
    const store = useSearchStore.getState();
    store.setScope(newScope);
    if (store.query.trim()) {
      store.search();
    }
  }, []);

  const handleAuthorChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const store = useSearchStore.getState();
      store.setAuthorId(e.target.value);
      if (store.query.trim()) {
        store.search();
      }
    },
    [],
  );

  const handleAttachmentToggle = useCallback(() => {
    const store = useSearchStore.getState();
    store.setHasAttachment(!store.hasAttachment);
    if (store.query.trim() || store.channelId) {
      store.search();
    }
  }, []);

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
              onChange={handleInputChange}
              placeholder={
                serverName ? `Search in ${serverName}...` : 'Search messages...'
              }
              className="w-full pl-9 pr-3 py-1.5 bg-bg-tertiary border border-border rounded-md text-sm text-text-primary placeholder:text-text-subtle focus:outline-none focus:ring-1 focus:ring-accent"
            />
          </div>
          <button
            type="button"
            onClick={() => setShowFilters(!showFilters)}
            className={`px-2 py-1.5 rounded-md border text-sm transition-colors ${
              showFilters
                ? 'bg-accent/10 border-accent text-accent'
                : 'bg-bg-tertiary border-border text-text-subtle hover:text-text-secondary'
            }`}
            title="Toggle filters"
          >
            <FunnelIcon className="size-4" />
          </button>
        </form>

        {/* Scope toggle */}
        <div className="flex gap-1 mt-2">
          <button
            type="button"
            onClick={() => handleScopeToggle('channel')}
            className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
              scope === 'channel'
                ? 'bg-accent/15 text-accent'
                : 'text-text-subtle hover:text-text-secondary'
            }`}
          >
            Current Channel
          </button>
          <button
            type="button"
            onClick={() => handleScopeToggle('all')}
            className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
              scope === 'all'
                ? 'bg-accent/15 text-accent'
                : 'text-text-subtle hover:text-text-secondary'
            }`}
          >
            All Channels
          </button>
        </div>

        {/* Filters panel */}
        {showFilters && (
          <div className="flex flex-wrap gap-3 mt-2 pt-2 border-t border-border">
            {/* Author dropdown */}
            <div className="flex items-center gap-1.5">
              <label
                htmlFor="search-author"
                className="text-xs text-text-subtle"
              >
                Author:
              </label>
              <select
                id="search-author"
                onChange={handleAuthorChange}
                className="text-xs bg-bg-tertiary border border-border rounded px-1.5 py-1 text-text-primary"
              >
                <option value="">Any</option>
                {members?.map((m) => (
                  <option key={m.userId} value={m.userId}>
                    {m.nickname || m.userId.slice(0, 8)}
                  </option>
                ))}
              </select>
            </div>

            {/* Attachment checkbox */}
            <label className="flex items-center gap-1.5 text-xs text-text-subtle cursor-pointer">
              <input
                type="checkbox"
                checked={hasAttachment}
                onChange={handleAttachmentToggle}
                className="rounded border-border"
              />
              <PaperclipIcon className="size-3.5" />
              Has files
            </label>
          </div>
        )}

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
            Type a query to search messages
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
                key={result.message?.id ?? result.localHit?.id ?? `r-${i}`}
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
    result.message?.channelId ?? result.localHit?.channelId ?? '';
  const authorId = result.message?.authorId ?? result.localHit?.authorId ?? '';
  const messageId = result.message?.id ?? result.localHit?.id ?? '';

  const channelName = channelNameMap.get(channelId);
  const authorName = useDisplayName(authorId, selectedServerId ?? undefined);

  // Get content: decrypted content from server, or fetch from message store for local hits
  const messageContent = useMessageStore(
    (s) => s.byId[channelId]?.[messageId]?.encryptedContent,
  );

  let content = '';
  if (result.decryptedContent) {
    content = result.decryptedContent;
  } else if (result.source === 'local' && messageContent?.length) {
    // Local hit — content is in the message store (already decrypted)
    try {
      const parsed = parseMessageContent(messageContent);
      content = parsed.text;
    } catch {
      content = '';
    }
  } else if (result.source === 'server') {
    const hasAttachments =
      result.message?.attachments && result.message.attachments.length > 0;
    content = hasAttachments ? 'Message with attachments' : 'Encrypted message';
  }

  // Format timestamp
  const timestamp = result.message?.createdAt
    ? new Date(
        Number(result.message.createdAt.seconds) * 1000,
      ).toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      })
    : result.localHit?.createdAt
      ? new Date(result.localHit.createdAt).toLocaleDateString(undefined, {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
        })
      : '';

  const handleClick = useCallback(() => {
    if (!focusedPaneId || !channelId) return;

    // Navigate to the channel
    setPaneContent(focusedPaneId, { type: 'channel', channelId });

    // Jump to message: set historical view mode and fetch around the target
    if (messageId) {
      const msgStore = useMessageStore.getState();
      msgStore.setViewMode(channelId, 'historical');
      getMessages(channelId, { around: messageId })
        .then(() => {
          // Scroll to and highlight the target message
          requestAnimationFrame(() => {
            const el = document.querySelector(
              `[data-message-id="${CSS.escape(messageId)}"]`,
            );
            if (el) {
              el.scrollIntoView({ behavior: 'smooth', block: 'center' });
              el.animate(
                [
                  {
                    backgroundColor:
                      'rgba(var(--accent-rgb, 99 102 241) / 0.15)',
                  },
                  { backgroundColor: 'transparent' },
                ],
                { duration: 1500, easing: 'ease-out' },
              );
            }
          });
        })
        .catch(() => {});
    }
  }, [focusedPaneId, channelId, messageId, setPaneContent]);

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
        {result.source === 'server' && !result.decryptedContent ? (
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
