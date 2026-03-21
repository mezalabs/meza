import { getMediaURL, useEmojiStore } from '@meza/core';
import { useEffect, useMemo, useRef, useState } from 'react';

interface EmojiAutocompleteProps {
  query: string;
  serverId?: string;
  onSelect: (insertText: string) => void;
  onClose: () => void;
  position: { bottom: number; left: number };
}

const MAX_RESULTS = 8;

export function EmojiAutocomplete({
  query,
  serverId,
  onSelect,
  onClose,
  position,
}: EmojiAutocompleteProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
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

    // Search personal emojis first
    for (const e of personalEmojis) {
      if (results.length >= MAX_RESULTS) break;
      if (e.name.includes(lowerQuery)) {
        results.push(e);
      }
    }

    // Then server emojis (avoid duplicates by id)
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

  // Reset selection when query changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional reset on query change
  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  // Scroll selected item into view.
  useEffect(() => {
    const el = listRef.current?.children[selectedIndex] as HTMLElement;
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  // Keyboard navigation (capture phase, same pattern as MentionAutocomplete).
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, items.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        if (items.length > 0) {
          e.preventDefault();
          const emoji = items[selectedIndex];
          const ref = emoji.animated
            ? `<a:${emoji.name}:${emoji.id}>`
            : `<:${emoji.name}:${emoji.id}>`;
          onSelect(ref);
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    }
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [items, selectedIndex, onSelect, onClose]);

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
              i === selectedIndex
                ? 'bg-accent/15 text-accent'
                : 'text-text hover:bg-bg-surface'
            }`}
            onMouseDown={(e) => {
              e.preventDefault();
              onSelect(ref);
            }}
            onMouseEnter={() => setSelectedIndex(i)}
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
