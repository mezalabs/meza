import {
  getAllUnicodeEmojis,
  getEmojiGroups,
  getFrequentEmojis,
  getShortcodes,
  listEmojis,
  listUserEmojis,
  loadEmojiData,
  recordUsage,
  type SearchResult,
  type StoredEmoji,
  searchEmojis,
  useEmojiStore,
  useServerStore,
} from '@meza/core';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMobile } from '../../hooks/useMobile.ts';
import { EmojiPickerGrid } from './EmojiPickerGrid.tsx';
import type { PreviewEmoji } from './EmojiPickerPreview.tsx';
import { EmojiPickerPreview } from './EmojiPickerPreview.tsx';
import { EmojiPickerSearch } from './EmojiPickerSearch.tsx';
import { EmojiPickerSkinTone } from './EmojiPickerSkinTone.tsx';

// ----- Constants -----

const PICKER_MAX_WIDTH = 380;
const PICKER_MAX_WIDTH_MOBILE = 340;
const PICKER_HEIGHT = 420;
const PICKER_HEIGHT_MOBILE = 272; // search (~44px) + header (28px) + 5 rows (5×40px)
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
  autoFocus?: boolean;
  /** Called when the search input gains or loses focus (mobile panel mode). */
  onSearchFocusChange?: (focused: boolean) => void;
}

export const EmojiPicker = memo(function EmojiPicker({
  onEmojiSelect,
  serverId,
  autoFocus = true,
  onSearchFocusChange,
}: EmojiPickerProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [previewEmoji, setPreviewEmoji] = useState<PreviewEmoji | null>(null);
  const [skinTone, setSkinTone] = useState(getSavedSkinTone);
  const [dataLoaded, setDataLoaded] = useState(() => getEmojiGroups() !== null);
  const [loadError, setLoadError] = useState(false);
  const [searchFocused, setSearchFocused] = useState(true);
  const isMobile = useMobile();
  const pickerWidth = isMobile ? PICKER_MAX_WIDTH_MOBILE : PICKER_MAX_WIDTH;
  const pickerHeight = isMobile ? PICKER_HEIGHT_MOBILE : PICKER_HEIGHT;

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

  // Debounce search query so searchEmojis doesn't run on every keystroke
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(searchQuery), 150);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  // Fetch custom emojis
  const serverEmojis = useEmojiStore((s) =>
    serverId ? s.byServer[serverId] : undefined,
  );
  const personalEmojis = useEmojiStore((s) => s.personal);
  const emojisByServer = useEmojiStore((s) => s.byServer);

  useEffect(() => {
    if (serverId && !serverEmojis) {
      listEmojis(serverId).catch(() => {});
    }
  }, [serverId, serverEmojis]);

  useEffect(() => {
    if (personalEmojis === null) {
      listUserEmojis().catch(() => {});
    }
  }, [personalEmojis]);

  // All servers the user is in (for other-server emojis + names)
  const servers = useServerStore((s) => s.servers);

  // Load emojis for other servers the user is in
  const fetchedRef = useRef(new Set<string>());

  useEffect(() => {
    for (const sid of Object.keys(servers)) {
      if (
        sid !== serverId &&
        !emojisByServer[sid] &&
        !fetchedRef.current.has(sid)
      ) {
        fetchedRef.current.add(sid);
        listEmojis(sid).catch(() => {});
      }
    }
  }, [servers, serverId, emojisByServer]);

  // Build other-server emoji groups (servers that aren't the current one)
  const otherServerEmojiGroups = useMemo(() => {
    const groups: {
      serverId: string;
      serverName: string;
      emojis: StoredEmoji[];
    }[] = [];
    for (const [sid, emojis] of Object.entries(emojisByServer)) {
      if (sid === serverId || emojis.length === 0) continue;
      groups.push({
        serverId: sid,
        serverName: servers[sid]?.name ?? sid,
        emojis,
      });
    }
    return groups;
  }, [emojisByServer, serverId, servers]);

  // Server name for preview
  const serverName = useServerStore((s) =>
    serverId ? s.servers[serverId]?.name : undefined,
  );

  // Frequently used (read once on mount)
  const [frequentEmojis] = useState(() => getFrequentEmojis());

  // Search — include all custom emojis from all sources
  const allCustom: StoredEmoji[] = useMemo(() => {
    const seenIds = new Set<string>();
    const result: StoredEmoji[] = [];
    for (const e of personalEmojis ?? []) {
      if (!seenIds.has(e.id)) {
        seenIds.add(e.id);
        result.push(e);
      }
    }
    if (serverEmojis) {
      for (const e of serverEmojis) {
        if (!seenIds.has(e.id)) {
          seenIds.add(e.id);
          result.push(e);
        }
      }
    }
    for (const group of otherServerEmojiGroups) {
      for (const e of group.emojis) {
        if (!seenIds.has(e.id)) {
          seenIds.add(e.id);
          result.push(e);
        }
      }
    }
    return result;
  }, [personalEmojis, serverEmojis, otherServerEmojiGroups]);

  const searchResults: SearchResult[] | null = useMemo(() => {
    if (!debouncedQuery) return null;
    return searchEmojis(
      debouncedQuery,
      allCustom,
      getAllUnicodeEmojis(),
      getShortcodes(),
    );
  }, [debouncedQuery, allCustom]);

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

  const handleGridFocus = useCallback(() => {
    setSearchFocused(false);
  }, []);

  // Loading/error states
  if (loadError) {
    return (
      <div
        className="flex items-center justify-center rounded-xl bg-bg-elevated"
        style={{ width: pickerWidth, maxWidth: '100vw' }}
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
        style={{ width: pickerWidth, maxWidth: '100vw' }}
      >
        <span className="text-sm text-text-muted">Loading emoji…</span>
      </div>
    );
  }

  // When embedded in mobile panel (onSearchFocusChange provided), fill container
  const isEmbedded = !!onSearchFocusChange;

  return (
    <div
      className="flex flex-col bg-bg-elevated overflow-hidden"
      style={
        isEmbedded
          ? { width: '100%', height: '100%' }
          : {
              width: pickerWidth,
              height: pickerHeight,
              maxWidth: '100vw',
              maxHeight: '100%',
              borderRadius: '0.75rem',
            }
      }
    >
      {/* Search + skin tone */}
      <div className="flex items-end gap-1 pr-2">
        <div className="flex-1">
          <EmojiPickerSearch
            value={searchQuery}
            onChange={setSearchQuery}
            autoFocus={autoFocus}
            onFocusChange={onSearchFocusChange}
          />
        </div>
        <EmojiPickerSkinTone value={skinTone} onChange={handleSkinToneChange} />
      </div>

      {/* Emoji grid */}
      <EmojiPickerGrid
        personalEmojis={personalEmojis ?? []}
        serverEmojis={serverEmojis ?? []}
        otherServerEmojiGroups={otherServerEmojiGroups}
        frequentEmojis={frequentEmojis}
        emojiGroups={getEmojiGroups()}
        searchResults={searchResults}
        skinTone={skinTone}
        serverName={serverName}
        onSelect={handleSelect}
        onHover={setPreviewEmoji}
        searchFocused={searchFocused}
        onFocusSearch={handleFocusSearch}
        onGridFocus={handleGridFocus}
      />

      {/* Preview bar (desktop only) */}
      <EmojiPickerPreview emoji={previewEmoji} />
    </div>
  );
});
