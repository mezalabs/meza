import { getMediaURL, useEmojiStore } from '@meza/core';
import { useEffect, useMemo, useRef } from 'react';

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

const MAX_RESULTS = 8;

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

  const items = useMemo(() => {
    if (!query) return [];
    const lowerQuery = query.toLowerCase();
    const results: {
      id: string;
      name: string;
      imageUrl: string;
      animated: boolean;
    }[] = [];

    for (const e of personalEmojis) {
      if (results.length >= MAX_RESULTS) break;
      if (e.name.includes(lowerQuery)) {
        results.push(e);
      }
    }

    if (serverEmojis) {
      const seen = new Set(results.map((r) => r.id));
      for (const e of serverEmojis) {
        if (results.length >= MAX_RESULTS) break;
        if (!seen.has(e.id) && e.name.includes(lowerQuery)) {
          results.push(e);
        }
      }
    }

    return results;
  }, [query, personalEmojis, serverEmojis]);

  // Expose wire-format refs to parent for Enter-key selection
  if (itemsRef) {
    itemsRef.current = items.map((e) =>
      e.animated ? `<a:${e.name}:${e.id}>` : `<:${e.name}:${e.id}>`,
    );
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
      {items.map((emoji, i) => {
        const attachmentId = emoji.imageUrl.replace('/media/', '');
        const ref = emoji.animated
          ? `<a:${emoji.name}:${emoji.id}>`
          : `<:${emoji.name}:${emoji.id}>`;
        return (
          <button
            key={emoji.id}
            type="button"
            className={`flex w-full items-center gap-2 px-3 py-1.5 text-sm text-left transition-colors ${
              i === clampedIndex
                ? 'bg-accent/15 text-accent'
                : 'text-text hover:bg-bg-surface'
            }`}
            onMouseDown={(e) => {
              e.preventDefault();
              onSelect(ref);
            }}
          >
            <img
              src={getMediaURL(attachmentId)}
              alt={`:${emoji.name}:`}
              className="h-6 w-6 object-contain"
              loading="lazy"
            />
            <span className="truncate">:{emoji.name}:</span>
          </button>
        );
      })}
    </div>
  );
}
