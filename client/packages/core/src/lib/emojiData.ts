/**
 * Unicode emoji data loader using emojibase.
 * Lazy-loads the data and caches it at module scope.
 */

export interface UnicodeEmoji {
  emoji: string;
  label: string;
  hexcode: string;
  tags?: string[];
  group: number;
  order: number;
  skins?: { emoji: string; label: string }[];
}

export interface EmojiGroup {
  key: string;
  label: string;
  order: number;
  emojis: UnicodeEmoji[];
}

export type ShortcodeMap = Record<string, string | string[]>;

/** Group metadata in display order (skip "component" group 2) */
const GROUP_META: { key: string; label: string; order: number }[] = [
  { key: 'smileys-emotion', label: 'Smileys & Emotion', order: 0 },
  { key: 'people-body', label: 'People & Body', order: 1 },
  // group 2 = components (skin tones) — excluded
  { key: 'animals-nature', label: 'Animals & Nature', order: 3 },
  { key: 'food-drink', label: 'Food & Drink', order: 4 },
  { key: 'travel-places', label: 'Travel & Places', order: 5 },
  { key: 'activities', label: 'Activities', order: 6 },
  { key: 'objects', label: 'Objects', order: 7 },
  { key: 'symbols', label: 'Symbols', order: 8 },
  { key: 'flags', label: 'Flags', order: 9 },
];

// Module-scope cache — survives unmount/remount
let cachedGroups: EmojiGroup[] | null = null;
let cachedShortcodes: ShortcodeMap | null = null;
let cachedAllEmojis: UnicodeEmoji[] | null = null;
let loadPromise: Promise<void> | null = null;

interface RawEmoji {
  emoji: string;
  label: string;
  hexcode: string;
  tags?: string[];
  group?: number;
  order?: number;
  skins?: { emoji: string; label: string }[];
}

function buildGroups(raw: RawEmoji[]): {
  groups: EmojiGroup[];
  allEmojis: UnicodeEmoji[];
} {
  const byGroup = new Map<number, UnicodeEmoji[]>();
  const allEmojis: UnicodeEmoji[] = [];

  for (const e of raw) {
    // Skip component emojis (skin tone modifiers) and emojis without a group
    if (e.group == null || e.group === 2) continue;
    const emoji: UnicodeEmoji = {
      emoji: e.emoji,
      label: e.label,
      hexcode: e.hexcode,
      tags: e.tags,
      group: e.group,
      order: e.order ?? 0,
      skins: e.skins?.map((s) => ({ emoji: s.emoji, label: s.label })),
    };
    const list = byGroup.get(e.group) ?? [];
    list.push(emoji);
    byGroup.set(e.group, list);
    allEmojis.push(emoji);
  }

  // Sort within each group by order
  for (const list of byGroup.values()) {
    list.sort((a, b) => a.order - b.order);
  }

  const groups: EmojiGroup[] = GROUP_META.filter((m) =>
    byGroup.has(m.order),
  ).map((m) => ({
    key: m.key,
    label: m.label,
    order: m.order,
    emojis: byGroup.get(m.order) ?? [],
  }));

  return { groups, allEmojis };
}

export function loadEmojiData(): Promise<void> {
  if (!loadPromise) {
    loadPromise = Promise.all([
      import('emojibase-data/en/data.json'),
      import('emojibase-data/en/shortcodes/emojibase.json'),
    ])
      .then(([dataModule, shortcodesModule]) => {
        const raw = (dataModule.default ?? dataModule) as RawEmoji[];
        const sc = (shortcodesModule.default ??
          shortcodesModule) as ShortcodeMap;
        const { groups, allEmojis } = buildGroups(raw);
        cachedGroups = groups;
        cachedShortcodes = sc;
        cachedAllEmojis = allEmojis;
      })
      .catch((err) => {
        loadPromise = null; // Allow retry
        throw err;
      });
  }
  return loadPromise;
}

export function getEmojiGroups(): EmojiGroup[] | null {
  return cachedGroups;
}

export function getShortcodes(): ShortcodeMap | null {
  return cachedShortcodes;
}

export function getAllUnicodeEmojis(): UnicodeEmoji[] | null {
  return cachedAllEmojis;
}

/** Apply a skin tone modifier to an emoji. Index 0 = default (no modifier), 1-5 = Fitzpatrick modifiers. */
export function applySkinTone(
  emoji: UnicodeEmoji,
  skinToneIndex: number,
): string {
  if (skinToneIndex === 0 || !emoji.skins) return emoji.emoji;
  const skin = emoji.skins[skinToneIndex - 1];
  return skin ? skin.emoji : emoji.emoji;
}
