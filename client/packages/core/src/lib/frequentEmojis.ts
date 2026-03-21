/**
 * Frequently used emoji tracking via localStorage.
 * Designed for future migration to server-side storage.
 */

const STORAGE_KEY = 'meza:frequent-emojis';
const MAX_ENTRIES = 30;
const DECAY_RATE = 0.95;

export interface FrequentEmojiEntry {
  /** Custom emoji: the emoji ID. Unicode: the native character. */
  key: string;
  type: 'custom' | 'unicode';
  count: number;
  lastUsed: number; // timestamp ms
}

type StoredData = Record<
  string,
  { count: number; lastUsed: number; type: 'custom' | 'unicode' }
>;

function readStore(): StoredData {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as StoredData;
  } catch {
    return {};
  }
}

function writeStore(data: StoredData): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    // localStorage full or unavailable — ignore
  }
}

function computeScore(
  entry: { count: number; lastUsed: number },
  now: number,
): number {
  const daysSince = (now - entry.lastUsed) / (1000 * 60 * 60 * 24);
  return entry.count * DECAY_RATE ** daysSince;
}

export function recordUsage(key: string, type: 'custom' | 'unicode'): void {
  const data = readStore();
  const existing = data[key];
  const now = Date.now();

  if (existing) {
    existing.count += 1;
    existing.lastUsed = now;
    existing.type = type;
  } else {
    data[key] = { count: 1, lastUsed: now, type };
  }

  // Evict lowest-scored entries if over cap
  const keys = Object.keys(data);
  if (keys.length > MAX_ENTRIES) {
    const scored = keys.map((k) => ({
      key: k,
      score: computeScore(data[k], now),
    }));
    scored.sort((a, b) => b.score - a.score);
    const keep = new Set(scored.slice(0, MAX_ENTRIES).map((s) => s.key));
    for (const k of keys) {
      if (!keep.has(k)) delete data[k];
    }
  }

  writeStore(data);
}

export function getFrequentEmojis(): FrequentEmojiEntry[] {
  const data = readStore();
  const now = Date.now();

  return Object.entries(data)
    .map(([key, entry]) => ({
      key,
      type: entry.type,
      count: entry.count,
      lastUsed: entry.lastUsed,
      score: computeScore(entry, now),
    }))
    .sort((a, b) => b.score - a.score)
    .map(({ key, type, count, lastUsed }) => ({ key, type, count, lastUsed }));
}

export function clearFrequentEmojis(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
