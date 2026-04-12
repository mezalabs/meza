import {
  applySkinTone,
  type EmojiGroup,
  type FrequentEmojiEntry,
  getMediaURL,
  type SearchResult,
  type StoredEmoji,
  type UnicodeEmoji,
} from '@meza/core';
import { TwemojiImg } from '../shared/TwemojiImg.tsx';
import { useVirtualizer } from '@tanstack/react-virtual';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMobile } from '../../hooks/useMobile.ts';
import type { PreviewEmoji } from './EmojiPickerPreview.tsx';

// ----- Constants -----

const COLS_DESKTOP = 9;
const EMOJI_SIZE = 32;
const BUTTON_SIZE = 40;
const HEADER_HEIGHT = 28;
const MIN_BUTTON_SIZE = 40;
const GRID_PADDING = 8; // px-1 each side = 4px × 2

// ----- Types -----

interface SectionHeader {
  kind: 'header';
  label: string;
}

interface EmojiRow {
  kind: 'row';
  items: GridItem[];
}

type GridRow = SectionHeader | EmojiRow;

interface CustomGridItem {
  type: 'custom';
  emoji: StoredEmoji;
}

interface UnicodeGridItem {
  type: 'unicode';
  emoji: UnicodeEmoji;
}

type GridItem = CustomGridItem | UnicodeGridItem;

// ----- Props -----

interface OtherServerEmojiGroup {
  serverId: string;
  serverName: string;
  emojis: StoredEmoji[];
}

interface EmojiPickerGridProps {
  personalEmojis: StoredEmoji[];
  serverEmojis: StoredEmoji[];
  otherServerEmojiGroups: OtherServerEmojiGroup[];
  frequentEmojis: FrequentEmojiEntry[];
  emojiGroups: EmojiGroup[] | null;
  searchResults: SearchResult[] | null;
  skinTone: number;
  serverName?: string;
  onSelect: (emojiText: string) => void;
  onHover: (preview: PreviewEmoji | null) => void;
  searchFocused: boolean;
  onFocusSearch: () => void;
  onGridFocus: () => void;
}

// ----- Helpers -----

function customToRef(e: StoredEmoji): string {
  return e.animated ? `<a:${e.name}:${e.id}>` : `<:${e.name}:${e.id}>`;
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

function addCustomSection(
  rows: GridRow[],
  label: string,
  emojis: StoredEmoji[],
  cols: number,
) {
  if (emojis.length === 0) return;
  rows.push({ kind: 'header', label });
  const items: CustomGridItem[] = emojis.map((e) => ({
    type: 'custom',
    emoji: e,
  }));
  for (const chunk of chunkArray(items, cols)) {
    rows.push({ kind: 'row', items: chunk });
  }
}

function buildRows(
  personalEmojis: StoredEmoji[],
  serverEmojis: StoredEmoji[],
  otherServerEmojiGroups: OtherServerEmojiGroup[],
  frequentEntries: FrequentEmojiEntry[],
  emojiGroups: EmojiGroup[] | null,
  allCustom: StoredEmoji[],
  unicodeMap: Map<string, UnicodeEmoji> | null,
  cols: number,
): GridRow[] {
  const rows: GridRow[] = [];

  // 1. Frequently used
  if (frequentEntries.length > 0) {
    const resolved: GridItem[] = [];
    const customById = new Map(allCustom.map((e) => [e.id, e]));

    for (const entry of frequentEntries) {
      if (entry.type === 'custom') {
        const emoji = customById.get(entry.key);
        if (emoji) resolved.push({ type: 'custom', emoji });
      } else if (unicodeMap) {
        const emoji = unicodeMap.get(entry.key);
        if (emoji) resolved.push({ type: 'unicode', emoji });
      }
    }

    if (resolved.length > 0) {
      rows.push({ kind: 'header', label: 'Frequently Used' });
      for (const chunk of chunkArray(resolved, cols)) {
        rows.push({ kind: 'row', items: chunk });
      }
    }
  }

  // 2. My Emojis (personal)
  addCustomSection(rows, 'My Emojis', personalEmojis, cols);

  // 3. Current server emojis
  addCustomSection(rows, 'Server Emojis', serverEmojis, cols);

  // 4. Other server emojis
  for (const group of otherServerEmojiGroups) {
    addCustomSection(rows, group.serverName, group.emojis, cols);
  }

  // 5. Unicode categories
  if (emojiGroups) {
    for (const group of emojiGroups) {
      if (group.emojis.length === 0) continue;
      rows.push({ kind: 'header', label: group.label });
      const items: UnicodeGridItem[] = group.emojis.map((e) => ({
        type: 'unicode',
        emoji: e,
      }));
      for (const chunk of chunkArray(items, cols)) {
        rows.push({ kind: 'row', items: chunk });
      }
    }
  }

  return rows;
}

function buildSearchRows(results: SearchResult[], cols: number): GridRow[] {
  const items: GridItem[] = results.map((r) => {
    if (r.type === 'custom') {
      return {
        type: 'custom' as const,
        emoji: {
          id: r.id,
          name: r.name,
          imageUrl: r.imageUrl,
          animated: r.animated,
          serverId: r.serverId,
          userId: r.userId,
        } as StoredEmoji,
      };
    }
    return {
      type: 'unicode' as const,
      emoji: {
        emoji: r.emoji,
        label: r.label,
        hexcode: r.hexcode,
        group: r.group,
        order: 0,
        skins: r.skins,
      },
    };
  });

  const rows: GridRow[] = [];
  for (const chunk of chunkArray(items, cols)) {
    rows.push({ kind: 'row', items: chunk });
  }
  return rows;
}

// ----- Component -----

export const EmojiPickerGrid = memo(function EmojiPickerGrid({
  personalEmojis,
  serverEmojis,
  otherServerEmojiGroups,
  frequentEmojis,
  emojiGroups,
  searchResults,
  skinTone,
  serverName,
  onSelect,
  onHover,
  searchFocused,
  onFocusSearch,
  onGridFocus,
}: EmojiPickerGridProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const isMobile = useMobile();

  // Measure container width so mobile can fill the full width with emojis
  const [containerWidth, setContainerWidth] = useState(0);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      setContainerWidth(entry.contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // On mobile: fit as many emojis as possible, then scale up to fill width
  const { cols, buttonSize, emojiSize, rowHeight } = useMemo(() => {
    if (!isMobile || containerWidth === 0) {
      return {
        cols: COLS_DESKTOP,
        buttonSize: BUTTON_SIZE,
        emojiSize: EMOJI_SIZE,
        rowHeight: BUTTON_SIZE,
      };
    }
    const usable = containerWidth - GRID_PADDING;
    const c = Math.max(1, Math.floor(usable / MIN_BUTTON_SIZE));
    const bs = usable / c;
    const es = Math.floor(bs * (EMOJI_SIZE / BUTTON_SIZE));
    return { cols: c, buttonSize: bs, emojiSize: es, rowHeight: bs };
  }, [isMobile, containerWidth]);

  // Build a map of all custom emojis for frequent lookup
  const allCustom = useMemo(() => {
    const result = [...personalEmojis, ...serverEmojis];
    for (const group of otherServerEmojiGroups) {
      result.push(...group.emojis);
    }
    return result;
  }, [personalEmojis, serverEmojis, otherServerEmojiGroups]);

  // Build unicode map for frequent emoji lookup
  const unicodeMap = useMemo(() => {
    if (!emojiGroups) return null;
    const map = new Map<string, UnicodeEmoji>();
    for (const group of emojiGroups) {
      for (const e of group.emojis) {
        map.set(e.emoji, e);
      }
    }
    return map;
  }, [emojiGroups]);

  const rows = useMemo(() => {
    if (searchResults) return buildSearchRows(searchResults, cols);
    return buildRows(
      personalEmojis,
      serverEmojis,
      otherServerEmojiGroups,
      frequentEmojis,
      emojiGroups,
      allCustom,
      unicodeMap,
      cols,
    );
  }, [
    searchResults,
    personalEmojis,
    serverEmojis,
    otherServerEmojiGroups,
    frequentEmojis,
    emojiGroups,
    allCustom,
    unicodeMap,
    cols,
  ]);

  // Flatten all emoji items for keyboard navigation
  const flatItems = useMemo(() => {
    const items: { rowIndex: number; colIndex: number; item: GridItem }[] = [];
    for (let ri = 0; ri < rows.length; ri++) {
      const row = rows[ri];
      if (row.kind === 'row') {
        for (let ci = 0; ci < row.items.length; ci++) {
          items.push({ rowIndex: ri, colIndex: ci, item: row.items[ci] });
        }
      }
    }
    return items;
  }, [rows]);

  // Build lookup map: "rowIndex:colIndex" -> flat index (avoids O(n) findIndex per cell)
  const flatIndexMap = useMemo(() => {
    const map = new Map<string, number>();
    for (let i = 0; i < flatItems.length; i++) {
      const fi = flatItems[i];
      map.set(`${fi.rowIndex}:${fi.colIndex}`, i);
    }
    return map;
  }, [flatItems]);

  // Virtualizer
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) =>
      rows[index].kind === 'header' ? HEADER_HEIGHT : rowHeight,
    overscan: 5,
  });

  // Reset focus when search changes
  // biome-ignore lint/correctness/useExhaustiveDependencies: searchResults is an intentional trigger dependency
  useEffect(() => {
    setFocusedIndex(-1);
  }, [searchResults]);

  // Keyboard navigation — use refs to avoid re-registering listener on every state change
  const focusedIndexRef = useRef(focusedIndex);
  focusedIndexRef.current = focusedIndex;
  const flatItemsRef = useRef(flatItems);
  flatItemsRef.current = flatItems;
  const searchFocusedRef = useRef(searchFocused);
  searchFocusedRef.current = searchFocused;

  const handleItemSelect = useCallback(
    (item: GridItem) => {
      if (item.type === 'custom') {
        onSelect(customToRef(item.emoji));
      } else {
        onSelect(applySkinTone(item.emoji, skinTone));
      }
      // Reset keyboard focus so the document-level Enter handler doesn't
      // re-insert the same emoji when the iOS keyboard pops up.
      setFocusedIndex(-1);
    },
    [onSelect, skinTone],
  );
  const handleItemSelectRef = useRef(handleItemSelect);
  handleItemSelectRef.current = handleItemSelect;

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const idx = focusedIndexRef.current;
      const items = flatItemsRef.current;
      const isSearchFocused = searchFocusedRef.current;

      // Only handle when picker is the active context
      if (idx === -1 && !isSearchFocused) return;

      // Let Escape propagate to Radix Popover for closing
      if (e.key === 'Escape') return;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (isSearchFocused || idx === -1) {
          if (items.length > 0) {
            setFocusedIndex(0);
            onGridFocus();
          }
          return;
        }
        const current = items[idx];
        if (!current) return;
        const targetCol = current.colIndex;
        for (let i = idx + 1; i < items.length; i++) {
          if (
            items[i].rowIndex > current.rowIndex &&
            items[i].colIndex >= targetCol
          ) {
            setFocusedIndex(i);
            return;
          }
        }
        // Fallback: first item of next row
        for (let i = idx + 1; i < items.length; i++) {
          if (items[i].rowIndex > current.rowIndex) {
            setFocusedIndex(i);
            return;
          }
        }
      }

      if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (idx <= 0) {
          setFocusedIndex(-1);
          onFocusSearch();
          return;
        }
        const current = items[idx];
        if (!current) return;
        const targetCol = current.colIndex;
        for (let i = idx - 1; i >= 0; i--) {
          if (
            items[i].rowIndex < current.rowIndex &&
            items[i].colIndex <= targetCol
          ) {
            setFocusedIndex(i);
            return;
          }
        }
        // Fallback: first item of previous row
        for (let i = idx - 1; i >= 0; i--) {
          if (items[i].rowIndex < current.rowIndex) {
            setFocusedIndex(i);
            return;
          }
        }
        setFocusedIndex(-1);
        onFocusSearch();
      }

      if (e.key === 'ArrowRight') {
        e.preventDefault();
        if (idx < items.length - 1) {
          setFocusedIndex(idx + 1);
          onGridFocus();
        }
      }

      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        if (idx > 0) {
          setFocusedIndex(idx - 1);
          onGridFocus();
        }
      }

      if (e.key === 'Enter' || e.key === 'Tab') {
        if (idx >= 0 && idx < items.length) {
          e.preventDefault();
          handleItemSelectRef.current(items[idx].item);
        }
      }
    }

    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [onFocusSearch, onGridFocus]);

  // Scroll focused item into view via virtualizer
  useEffect(() => {
    if (focusedIndex < 0 || focusedIndex >= flatItems.length) return;
    const fi = flatItems[focusedIndex];
    virtualizer.scrollToIndex(fi.rowIndex, { align: 'auto' });
  }, [focusedIndex, flatItems, virtualizer]);

  // Build server name lookup for preview
  const serverNames = useMemo(() => {
    const map = new Map<string, string>();
    if (serverName) {
      // Find the current server's ID from the server emojis
      for (const e of serverEmojis) {
        if (e.serverId) {
          map.set(e.serverId, serverName);
          break;
        }
      }
    }
    for (const group of otherServerEmojiGroups) {
      map.set(group.serverId, group.serverName);
    }
    return map;
  }, [serverName, serverEmojis, otherServerEmojiGroups]);

  // Update preview on focus
  useEffect(() => {
    if (focusedIndex < 0 || focusedIndex >= flatItems.length) {
      return;
    }
    const item = flatItems[focusedIndex].item;
    onHover(itemToPreview(item, serverNames));
  }, [focusedIndex, flatItems, onHover, serverNames]);

  const handleItemHover = useCallback(
    (item: GridItem) => {
      onHover(itemToPreview(item, serverNames));
    },
    [onHover, serverNames],
  );

  const handleButtonClick = useCallback(
    (index: number) => {
      setFocusedIndex(index);
      onGridFocus();
    },
    [onGridFocus],
  );

  if (rows.length === 0) {
    return (
      <div className="flex items-center justify-center h-48 text-sm text-text-muted">
        {searchResults !== null ? 'No emojis found' : 'Loading…'}
      </div>
    );
  }

  return (
    // biome-ignore lint/a11y/useSemanticElements: intentional ARIA grid pattern for emoji picker
    <div
      ref={scrollRef}
      className="emoji-picker-grid flex-1 min-h-0 overflow-y-auto overflow-x-hidden"
      onMouseLeave={() => onHover(null)}
      role="grid"
      aria-label="Emoji grid"
    >
      <div
        style={{
          height: virtualizer.getTotalSize(),
          width: '100%',
          position: 'relative',
        }}
      >
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const row = rows[virtualRow.index];
          return (
            <div
              key={virtualRow.key}
              data-index={virtualRow.index}
              ref={virtualizer.measureElement}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${virtualRow.start}px)`,
              }}
            >
              {row.kind === 'header' ? (
                // biome-ignore lint/a11y/useFocusableInteractive: grid header, not interactive
                // biome-ignore lint/a11y/useSemanticElements: intentional ARIA grid pattern
                <div
                  className="px-3 pt-2 pb-0.5 text-xs font-semibold uppercase tracking-wider text-text-subtle"
                  role="rowheader"
                  style={{ height: HEADER_HEIGHT }}
                >
                  {row.label}
                </div>
              ) : (
                // biome-ignore lint/a11y/useFocusableInteractive: row container, children are interactive
                // biome-ignore lint/a11y/useSemanticElements: intentional ARIA grid pattern
                <div
                  className="flex px-1"
                  role="row"
                  style={{ height: rowHeight }}
                >
                  {row.items.map((item, colIdx) => {
                    const globalIdx =
                      flatIndexMap.get(`${virtualRow.index}:${colIdx}`) ?? -1;
                    const isFocused = globalIdx === focusedIndex;

                    return (
                      <EmojiButton
                        key={
                          item.type === 'custom'
                            ? item.emoji.id
                            : item.emoji.hexcode
                        }
                        item={item}
                        skinTone={skinTone}
                        focused={isFocused}
                        onSelect={handleItemSelect}
                        onHover={handleItemHover}
                        globalIdx={globalIdx}
                        onFocusChange={handleButtonClick}
                        buttonSize={buttonSize}
                        emojiSize={emojiSize}
                      />
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
});

// ----- EmojiButton -----

const EmojiButton = memo(function EmojiButton({
  item,
  skinTone,
  focused,
  onSelect,
  onHover,
  globalIdx,
  onFocusChange,
  buttonSize: bs,
  emojiSize: es,
}: {
  item: GridItem;
  skinTone: number;
  focused: boolean;
  onSelect: (item: GridItem) => void;
  onHover: (item: GridItem) => void;
  globalIdx: number;
  onFocusChange: (index: number) => void;
  buttonSize: number;
  emojiSize: number;
}) {
  const label =
    item.type === 'custom' ? `:${item.emoji.name}:` : item.emoji.label;
  const [retries, setRetries] = useState(0);

  const handleImgError = useCallback(() => {
    // Retry once after a short delay to handle transient network failures
    // (e.g. proxy dropping connections under load on mobile dev)
    if (retries < 1) {
      setTimeout(() => setRetries((r) => r + 1), 500);
    }
  }, [retries]);

  return (
    // biome-ignore lint/a11y/useSemanticElements: intentional ARIA grid pattern
    <button
      type="button"
      role="gridcell"
      aria-label={label}
      className={`flex items-center justify-center rounded-md transition-colors ${
        focused ? 'bg-accent/20 ring-2 ring-accent' : 'hover:bg-bg-elevated'
      }`}
      style={{ width: bs, height: bs }}
      onClick={() => {
        onFocusChange(globalIdx);
        onSelect(item);
      }}
      onMouseEnter={() => onHover(item)}
    >
      {item.type === 'custom' ? (
        <img
          src={
            getMediaURL(item.emoji.imageUrl.replace('/media/', '')) +
            (retries > 0 ? `&_r=${retries}` : '')
          }
          alt={label}
          className="object-contain"
          style={{ width: es, height: es }}
          onError={handleImgError}
        />
      ) : (
        <TwemojiImg
          emoji={applySkinTone(item.emoji, skinTone)}
          size={es}
        />
      )}
    </button>
  );
});

// ----- Preview helper -----

function itemToPreview(
  item: GridItem,
  serverNames: Map<string, string>,
): PreviewEmoji {
  if (item.type === 'custom') {
    const attachmentId = item.emoji.imageUrl.replace('/media/', '');
    const source = item.emoji.userId
      ? 'Personal'
      : (serverNames.get(item.emoji.serverId) ?? 'Server');
    return {
      type: 'custom',
      display: attachmentId,
      name: item.emoji.name,
      source,
      animated: item.emoji.animated,
    };
  }
  return {
    type: 'unicode',
    display: item.emoji.emoji,
    name: item.emoji.label,
    source: '',
  };
}
