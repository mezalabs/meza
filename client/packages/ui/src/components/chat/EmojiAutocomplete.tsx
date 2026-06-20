import {
  getAllUnicodeEmojis,
  getMediaURL,
  getShortcodes,
  loadEmojiData,
  type SearchResult,
  type StoredEmoji,
  searchEmojis,
  useEmojiStore,
} from '@meza/core';
import { useEffect, useMemo, useRef } from 'react';
import { TwemojiImg } from '../shared/TwemojiImg.tsx';

interface EmojiAutocompleteProps {
  query: string;
  serverId?: string;
  /** Controlled highlight index (driven by prosemirror-autocomplete arrow keys). */
  selectedIndex: number;
  onSelect: (insertText: string) => void;
  position: { bottom: number; left: number };
  /** Optional ref to expose wire-format refs for Enter-key selection. */
  itemsRef?: React.MutableRefObject<string[]>;
}

const MAX_RESULTS = 10;

export function EmojiAutocomplete({
  query,
  serverId,
  selectedIndex,
  onSelect,
  position,
  itemsRef,
}: EmojiAutocompleteProps) {
  const listRef = useRef<HTMLDivElement>(null);

  const serverEmojis = useEmojiStore((s) =>
    serverId ? s.byServer[serverId] : undefined,
  );
  const personalEmojis = useEmojiStore((s) => s.personal) ?? [];
  const allEmojisByServer = useEmojiStore((s) => s.byServer);

  // Ensure Unicode emoji data is loaded
  useEffect(() => {
    if (!getAllUnicodeEmojis()) {
      loadEmojiData().catch(() => {});
    }
  }, []);

  // Combine all custom emojis (personal + server + other servers)
  const allCustom: StoredEmoji[] = useMemo(() => {
    const seen = new Set<string>();
    const result: StoredEmoji[] = [];
    for (const e of personalEmojis) {
      if (!seen.has(e.id)) {
        seen.add(e.id);
        result.push(e);
      }
    }
    if (serverEmojis) {
      for (const e of serverEmojis) {
        if (!seen.has(e.id)) {
          seen.add(e.id);
          result.push(e);
        }
      }
    }
    for (const [sid, emojis] of Object.entries(allEmojisByServer)) {
      if (sid === serverId) continue;
      for (const e of emojis) {
        if (!seen.has(e.id)) {
          seen.add(e.id);
          result.push(e);
        }
      }
    }
    return result;
  }, [personalEmojis, serverEmojis, allEmojisByServer, serverId]);

  const items: SearchResult[] = useMemo(() => {
    if (!query) return [];
    return searchEmojis(
      query,
      allCustom,
      getAllUnicodeEmojis(),
      getShortcodes(),
    ).slice(0, MAX_RESULTS);
  }, [query, allCustom]);

  // Build wire-format strings for Enter-key selection
  const wireFormats = useMemo(() => {
    return items.map((item) => {
      if (item.type === 'custom') {
        return item.animated
          ? `<a:${item.name}:${item.id}>`
          : `<:${item.name}:${item.id}>`;
      }
      // Unicode emoji — insert the emoji character directly
      return item.emoji;
    });
  }, [items]);

  // Expose wire-format refs to parent for Enter-key selection
  if (itemsRef) {
    itemsRef.current = wireFormats;
  }

  const clampedIndex = Math.min(selectedIndex, Math.max(0, items.length - 1));

  // Scroll selected item into view.
  useEffect(() => {
    const el = listRef.current?.children[clampedIndex] as HTMLElement;
    el?.scrollIntoView({ block: 'nearest' });
  }, [clampedIndex]);

  if (items.length === 0) return null;

  return (
    <div
      className="absolute z-50 w-64 max-h-48 overflow-y-auto rounded-md border border-border bg-bg-elevated shadow-lg"
      style={{ bottom: position.bottom, left: position.left }}
      ref={listRef}
    >
      {items.map((item, i) => {
        const wire = wireFormats[i];
        const key =
          item.type === 'custom' ? `c-${item.id}` : `u-${item.hexcode}`;
        return (
          <button
            key={key}
            type="button"
            className={`flex w-full items-center gap-2 px-3 py-1.5 text-sm text-left transition-colors ${
              i === clampedIndex
                ? 'bg-accent/15 text-accent'
                : 'text-text hover:bg-bg-surface'
            }`}
            onMouseDown={(e) => {
              e.preventDefault();
              onSelect(wire);
            }}
          >
            {item.type === 'custom' ? (
              <img
                src={getMediaURL(item.imageUrl.replace('/media/', ''))}
                alt={`:${item.name}:`}
                className="h-6 w-6 object-contain"
                loading="lazy"
              />
            ) : (
              <TwemojiImg emoji={item.emoji} size={24} />
            )}
            <span className="truncate">
              {item.type === 'custom' ? `:${item.name}:` : item.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}
