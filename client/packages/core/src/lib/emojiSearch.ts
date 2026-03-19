/**
 * Unified emoji search across custom and Unicode emojis.
 */
import type { CustomEmoji } from '@meza/gen/meza/v1/models_pb.ts';
import type { ShortcodeMap, UnicodeEmoji } from './emojiData.ts';

export interface CustomSearchResult {
  type: 'custom';
  id: string;
  name: string;
  imageUrl: string;
  animated: boolean;
  serverId: string;
  userId: string;
}

export interface UnicodeSearchResult {
  type: 'unicode';
  emoji: string;
  label: string;
  hexcode: string;
  group: number;
  skins?: { emoji: string; label: string }[];
}

export type SearchResult = CustomSearchResult | UnicodeSearchResult;

const MAX_RESULTS = 50;

export function searchEmojis(
  query: string,
  customEmojis: CustomEmoji[],
  unicodeEmojis: UnicodeEmoji[] | null,
  shortcodes: ShortcodeMap | null,
): SearchResult[] {
  if (!query || query.length < 1) return [];

  const lowerQuery = query.toLowerCase();
  const results: SearchResult[] = [];

  // Search custom emojis first (by name, substring match)
  for (const e of customEmojis) {
    if (results.length >= MAX_RESULTS) return results;
    if (e.name.toLowerCase().includes(lowerQuery)) {
      results.push({
        type: 'custom',
        id: e.id,
        name: e.name,
        imageUrl: e.imageUrl,
        animated: e.animated,
        serverId: e.serverId,
        userId: e.userId,
      });
    }
  }

  // Search Unicode emojis (by label, tags, and shortcodes)
  if (unicodeEmojis) {
    for (const e of unicodeEmojis) {
      if (results.length >= MAX_RESULTS) break;

      // Check label
      if (e.label.toLowerCase().includes(lowerQuery)) {
        results.push(toUnicodeResult(e));
        continue;
      }

      // Check tags
      if (e.tags?.some((t) => t.toLowerCase().includes(lowerQuery))) {
        results.push(toUnicodeResult(e));
        continue;
      }

      // Check shortcodes
      if (shortcodes) {
        const sc = shortcodes[e.hexcode];
        if (sc) {
          const codes = Array.isArray(sc) ? sc : [sc];
          if (codes.some((c) => c.toLowerCase().includes(lowerQuery))) {
            results.push(toUnicodeResult(e));
          }
        }
      }
    }
  }

  return results;
}

function toUnicodeResult(e: UnicodeEmoji): UnicodeSearchResult {
  return {
    type: 'unicode',
    emoji: e.emoji,
    label: e.label,
    hexcode: e.hexcode,
    group: e.group,
    skins: e.skins,
  };
}
