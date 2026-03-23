import { ChannelType, useChannelStore } from '@meza/core';
import { HashIcon, SpeakerHighIcon } from '@phosphor-icons/react';
import { useEffect, useMemo, useRef } from 'react';

export interface ChannelItem {
  id: string;
  name: string;
  type: 'text' | 'voice';
}

interface ChannelAutocompleteProps {
  query: string;
  serverId?: string;
  /** Controlled highlight index (driven by prosemirror-autocomplete arrow keys). */
  selectedIndex: number;
  onSelect: (item: ChannelItem) => void;
  position: { bottom: number; left: number };
  /** Optional ref to expose current items for Enter-key selection. */
  itemsRef?: React.MutableRefObject<ChannelItem[]>;
}

const MAX_RESULTS = 10;
const EMPTY_CHANNELS: ReturnType<
  typeof useChannelStore.getState
>['byServer'][string] = [];

export function ChannelAutocomplete({
  query,
  serverId,
  selectedIndex,
  onSelect,
  position,
  itemsRef,
}: ChannelAutocompleteProps) {
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

  // Expose items to parent for Enter-key selection
  if (itemsRef) itemsRef.current = items;

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
      {items.map((item, i) => (
        <button
          key={item.id}
          type="button"
          className={`flex w-full items-center gap-2 px-3 py-1.5 text-sm text-left transition-colors ${
            i === clampedIndex
              ? 'bg-accent/15 text-accent'
              : 'text-text hover:bg-bg-surface'
          }`}
          onMouseDown={(e) => {
            e.preventDefault();
            onSelect(item);
          }}
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
