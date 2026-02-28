import { Document, type DocumentData } from 'flexsearch';

export interface IndexedMessage extends DocumentData {
  id: string;
  channelId: string;
  authorId: string;
  content: string;
  createdAt: number; // unix ms
}

export interface LocalSearchResult {
  id: string;
  channelId: string;
  authorId: string;
  content: string;
  createdAt: number;
}

/** Maximum number of per-channel indexes kept in memory. */
const MAX_INDEXES = 30;

// Per-channel FlexSearch Document indexes for decrypted private message content.
const indexes = new Map<string, Document<IndexedMessage>>();

// LRU access order — most recently accessed channel IDs at the end.
const accessOrder: string[] = [];

/** Record a channel as recently accessed, moving it to the end of the LRU list. */
function touchChannel(channelId: string): void {
  const i = accessOrder.indexOf(channelId);
  if (i !== -1) accessOrder.splice(i, 1);
  accessOrder.push(channelId);
}

/** Evict the least-recently-used index when capacity is exceeded. */
function evictIfNeeded(): void {
  while (indexes.size > MAX_INDEXES && accessOrder.length > 0) {
    const oldest = accessOrder.shift();
    if (oldest) indexes.delete(oldest);
  }
}

function getOrCreateIndex(channelId: string): Document<IndexedMessage> {
  let idx = indexes.get(channelId);
  if (!idx) {
    idx = new Document<IndexedMessage>({
      document: {
        id: 'id',
        index: ['content'],
        store: ['id', 'channelId', 'authorId', 'content', 'createdAt'],
      },
      tokenize: 'forward',
      resolution: 9,
    });
    indexes.set(channelId, idx);
    evictIfNeeded();
  }
  touchChannel(channelId);
  return idx;
}

/** Index a decrypted message for local search. */
export function indexMessage(msg: IndexedMessage): void {
  const idx = getOrCreateIndex(msg.channelId);
  idx.add(msg);
}

/** Search decrypted messages across all indexed channels or within a specific channel. */
export function searchLocal(
  query: string,
  channelId?: string,
  limit = 25,
): LocalSearchResult[] {
  if (!query.trim()) return [];

  const results: LocalSearchResult[] = [];
  const seen = new Set<string>();

  let targetIndexes: (Document<IndexedMessage> | undefined)[];
  if (channelId) {
    targetIndexes = [indexes.get(channelId)].filter(Boolean);
  } else {
    // Limit cross-channel search to the most recently accessed indexes.
    const recentChannels = accessOrder.slice(-MAX_INDEXES);
    targetIndexes = recentChannels.map((id) => indexes.get(id)).filter(Boolean);
  }

  for (const idx of targetIndexes) {
    if (!idx) continue;
    const hits = idx.search(query, { limit, enrich: true });
    for (const field of hits) {
      for (const hit of field.result) {
        const doc = hit.doc as IndexedMessage | undefined;
        if (doc && !seen.has(doc.id)) {
          seen.add(doc.id);
          results.push({
            id: doc.id,
            channelId: doc.channelId,
            authorId: doc.authorId,
            content: doc.content,
            createdAt: doc.createdAt,
          });
        }
      }
    }
  }

  // Sort by createdAt descending (newest first).
  results.sort((a, b) => b.createdAt - a.createdAt);
  return results.slice(0, limit);
}

/** Check if a channel has any indexed messages. */
export function hasIndex(channelId: string): boolean {
  return indexes.has(channelId);
}

/** Clear all indexes. */
export function clearAllIndexes(): void {
  indexes.clear();
  accessOrder.length = 0;
}
