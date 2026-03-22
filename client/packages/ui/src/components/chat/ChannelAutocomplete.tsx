import { ChannelType, useChannelStore } from '@meza/core';
import { HashIcon, SpeakerHighIcon } from '@phosphor-icons/react';
import { useEffect, useMemo, useRef, useState } from 'react';

export interface ChannelItem {
  id: string;
  name: string;
  type: 'text' | 'voice';
}

interface ChannelAutocompleteProps {
  query: string;
  serverId?: string;
  onSelect: (item: ChannelItem) => void;
  onClose: () => void;
  position: { bottom: number; left: number };
}

const MAX_RESULTS = 10;
const EMPTY_CHANNELS: ReturnType<
  typeof useChannelStore.getState
>['byServer'][string] = [];

export function ChannelAutocomplete({
  query,
  serverId,
  onSelect,
  onClose,
  position,
}: ChannelAutocompleteProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const channels = useChannelStore((s) =>
    serverId ? (s.byServer[serverId] ?? EMPTY_CHANNELS) : EMPTY_CHANNELS,
  );

  const items = useMemo(() => {
    const lowerQuery = query.toLowerCase();
    const results: ChannelItem[] = [];

    for (const channel of channels) {
      if (results.length >= MAX_RESULTS) break;
      if (channel.name.toLowerCase().startsWith(lowerQuery) || !lowerQuery) {
        results.push({
          id: channel.id,
          name: channel.name,
          type: channel.type === ChannelType.VOICE ? 'voice' : 'text',
        });
      }
    }

    return results;
  }, [query, channels]);

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

  // Keyboard navigation (handled via capture-phase listener).
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
          onSelect(items[selectedIndex]);
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
      {items.map((item, i) => (
        <button
          key={item.id}
          type="button"
          className={`flex w-full items-center gap-2 px-3 py-1.5 text-sm text-left transition-colors ${
            i === selectedIndex
              ? 'bg-accent/15 text-accent'
              : 'text-text hover:bg-bg-surface'
          }`}
          onMouseDown={(e) => {
            e.preventDefault(); // Don't steal focus from textarea.
            onSelect(item);
          }}
          onMouseEnter={() => setSelectedIndex(i)}
        >
          <span className="flex h-6 w-6 shrink-0 items-center justify-center text-text-muted">
            {item.type === 'voice' ? (
              <SpeakerHighIcon weight="regular" size={16} aria-hidden="true" />
            ) : (
              <HashIcon weight="regular" size={16} aria-hidden="true" />
            )}
          </span>
          <span className="truncate">{item.name}</span>
        </button>
      ))}
    </div>
  );
}
