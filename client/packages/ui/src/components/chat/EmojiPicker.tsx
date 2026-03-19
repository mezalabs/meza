import {
  type CustomEmoji,
  type SearchResult,
  getAllUnicodeEmojis,
  getEmojiGroups,
  getFrequentEmojis,
  getShortcodes,
  listEmojis,
  listUserEmojis,
  loadEmojiData,
  recordUsage,
  searchEmojis,
  useEmojiStore,
  useServerStore,
} from '@meza/core';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { EmojiPickerGrid } from './EmojiPickerGrid.tsx';
import type { PreviewEmoji } from './EmojiPickerPreview.tsx';
import { EmojiPickerPreview } from './EmojiPickerPreview.tsx';
import { EmojiPickerSearch } from './EmojiPickerSearch.tsx';
import { EmojiPickerSkinTone } from './EmojiPickerSkinTone.tsx';

// ----- Constants -----

const PICKER_WIDTH = 380;
const SKIN_TONE_KEY = 'meza:skin-tone';

function getSavedSkinTone(): number {
  try {
    const val = localStorage.getItem(SKIN_TONE_KEY);
    if (val) {
      const n = Number.parseInt(val, 10);
      if (n >= 0 && n <= 5) return n;
    }
  } catch {
    // ignore
  }
  return 0;
}

// ----- Component -----

export interface EmojiPickerProps {
  onEmojiSelect: (text: string) => void;
  serverId?: string;
  closeOnSelect?: boolean;
  autoFocus?: boolean;
}

export const EmojiPicker = memo(function EmojiPicker({
  onEmojiSelect,
  serverId,
  autoFocus = true,
}: EmojiPickerProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [previewEmoji, setPreviewEmoji] = useState<PreviewEmoji | null>(null);
  const [skinTone, setSkinTone] = useState(getSavedSkinTone);
  const [dataLoaded, setDataLoaded] = useState(
    () => getEmojiGroups() !== null,
  );
  const [loadError, setLoadError] = useState(false);
  const [searchFocused, setSearchFocused] = useState(true);

  // Fetch emoji data
  useEffect(() => {
    if (dataLoaded) return;
    let cancelled = false;
    loadEmojiData()
      .then(() => {
        if (!cancelled) setDataLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [dataLoaded]);

  // Fetch custom emojis
  const serverEmojis = useEmojiStore((s) =>
    serverId ? s.byServer[serverId] : undefined,
  );
  const personalEmojis = useEmojiStore((s) => s.personal);

  useEffect(() => {
    if (serverId && !serverEmojis) {
      listEmojis(serverId).catch(() => {});
    }
  }, [serverId, serverEmojis]);

  useEffect(() => {
    if (personalEmojis.length === 0) {
      listUserEmojis().catch(() => {});
    }
  }, [personalEmojis.length]);

  // Server name for preview
  const serverName = useServerStore((s) =>
    serverId ? s.servers[serverId]?.name : undefined,
  );

  // Frequently used (read once on mount)
  const [frequentEmojis] = useState(() => getFrequentEmojis());

  // Search
  const allCustom: CustomEmoji[] = useMemo(() => {
    const result = [...personalEmojis];
    if (serverEmojis) {
      const seenIds = new Set(result.map((e) => e.id));
      for (const e of serverEmojis) {
        if (!seenIds.has(e.id)) result.push(e);
      }
    }
    return result;
  }, [personalEmojis, serverEmojis]);

  const searchResults: SearchResult[] | null = useMemo(() => {
    if (!searchQuery) return null;
    return searchEmojis(
      searchQuery,
      allCustom,
      getAllUnicodeEmojis(),
      getShortcodes(),
    );
  }, [searchQuery, allCustom]);

  // Handlers
  const handleSelect = useCallback(
    (emojiText: string) => {
      // Track usage
      const isCustom = emojiText.startsWith('<');
      if (isCustom) {
        // Extract emoji ID from <:name:id> or <a:name:id>
        const match = emojiText.match(/:([^:>]+)>$/);
        if (match) recordUsage(match[1], 'custom');
      } else {
        recordUsage(emojiText, 'unicode');
      }
      onEmojiSelect(emojiText);
    },
    [onEmojiSelect],
  );

  const handleSkinToneChange = useCallback((tone: number) => {
    setSkinTone(tone);
    try {
      localStorage.setItem(SKIN_TONE_KEY, String(tone));
    } catch {
      // ignore
    }
  }, []);

  const handleFocusSearch = useCallback(() => {
    setSearchFocused(true);
  }, []);

  // Loading/error states
  if (loadError) {
    return (
      <div
        className="flex items-center justify-center rounded-xl bg-bg-elevated"
        style={{ width: PICKER_WIDTH, height: 420 }}
      >
        <span className="text-sm text-text-muted">
          Failed to load emoji picker
        </span>
      </div>
    );
  }

  if (!dataLoaded) {
    return (
      <div
        className="flex items-center justify-center rounded-xl bg-bg-elevated"
        style={{ width: PICKER_WIDTH, height: 420 }}
      >
        <span className="text-sm text-text-muted">Loading emoji…</span>
      </div>
    );
  }

  return (
    <div
      className="flex flex-col rounded-xl bg-bg-elevated overflow-hidden"
      style={{ width: PICKER_WIDTH }}
    >
      {/* Search + skin tone */}
      <div className="flex items-end gap-1 pr-2">
        <div className="flex-1">
          <EmojiPickerSearch
            value={searchQuery}
            onChange={setSearchQuery}
            autoFocus={autoFocus}
          />
        </div>
        <EmojiPickerSkinTone value={skinTone} onChange={handleSkinToneChange} />
      </div>

      {/* Emoji grid */}
      <EmojiPickerGrid
        personalEmojis={personalEmojis}
        serverEmojis={serverEmojis ?? []}
        frequentEmojis={frequentEmojis}
        emojiGroups={getEmojiGroups()}
        searchResults={searchResults}
        skinTone={skinTone}
        serverName={serverName}
        onSelect={handleSelect}
        onHover={setPreviewEmoji}
        onEscape={() => {
          // Let parent handle close via popover
        }}
        searchFocused={searchFocused}
        onFocusSearch={handleFocusSearch}
      />

      {/* Preview bar (desktop only) */}
      <EmojiPickerPreview emoji={previewEmoji} />
    </div>
  );
});
