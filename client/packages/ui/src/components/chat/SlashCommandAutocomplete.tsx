import { useEffect, useMemo, useRef, useState } from 'react';
import { type SlashCommand, searchCommands } from '../../commands/index.ts';

interface SlashCommandAutocompleteProps {
  query: string;
  onSelect: (command: SlashCommand) => void;
  onClose: () => void;
}

const MAX_RESULTS = 10;

export function SlashCommandAutocomplete({
  query,
  onSelect,
  onClose,
}: SlashCommandAutocompleteProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const items = useMemo(
    () => searchCommands(query).slice(0, MAX_RESULTS),
    [query],
  );

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

  if (items.length === 0) {
    return (
      <div className="absolute bottom-full left-0 z-50 mb-1 w-72 rounded-md border border-border bg-bg-elevated p-3 shadow-lg">
        <span className="text-sm text-text-muted">No commands found</span>
      </div>
    );
  }

  return (
    <div
      className="absolute bottom-full left-0 z-50 mb-1 w-72 max-h-60 overflow-y-auto rounded-md border border-border bg-bg-elevated shadow-lg"
      ref={listRef}
    >
      {items.map((cmd, i) => (
        <button
          key={cmd.name}
          type="button"
          className={`flex w-full items-center gap-2 px-3 py-2 text-sm text-left transition-colors ${
            i === selectedIndex
              ? 'bg-accent/15 text-accent'
              : 'text-text hover:bg-bg-surface'
          }`}
          onMouseDown={(e) => {
            e.preventDefault();
            onSelect(cmd);
          }}
          onMouseEnter={() => setSelectedIndex(i)}
        >
          <span className="shrink-0 whitespace-nowrap font-medium text-text">
            /{cmd.name}
          </span>
          <span className="truncate text-text-muted">{cmd.description}</span>
        </button>
      ))}
    </div>
  );
}
