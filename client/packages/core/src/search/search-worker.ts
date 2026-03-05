// search-worker.ts — Web Worker owning FlexSearch indexes with IndexedDB persistence
import { Document, type DocumentData, IndexedDB } from 'flexsearch';
import type {
  IndexableMessage,
  SearchHit,
  SearchOpts,
  WorkerRequest,
  WorkerResponse,
} from './types.ts';

const MAX_HOT_CHANNELS = 10;
const COMMIT_INTERVAL_MS = 5_000;
const COMMIT_BATCH_THRESHOLD = 50;

// Per-channel FlexSearch Document indexes
const indexes = new Map<string, Document>();
const dbs = new Map<string, IndexedDB>();
const accessOrder: string[] = [];

// Init deduplication: prevents concurrent mount() for the same channel
const initializing = new Map<string, Promise<void>>();

// Per-channel operation queue: serializes all mutations
const channelQueues = new Map<string, Promise<void>>();

// Debounced commit state
const dirtyChannels = new Set<string>();
let commitTimer: ReturnType<typeof setTimeout> | null = null;
let pendingMutations = 0;

function touchChannel(channelId: string): void {
  const i = accessOrder.indexOf(channelId);
  if (i !== -1) accessOrder.splice(i, 1);
  accessOrder.push(channelId);
}

async function evictIfNeeded(): Promise<void> {
  while (indexes.size > MAX_HOT_CHANNELS && accessOrder.length > 0) {
    const oldest = accessOrder.shift();
    if (!oldest) break;
    const index = indexes.get(oldest);
    if (index) {
      try {
        await index.commit();
      } catch {
        // best effort persist before evict
      }
    }
    indexes.delete(oldest);
    dbs.delete(oldest);
  }
}

async function doInit(channelId: string): Promise<void> {
  const db = new IndexedDB(`meza-search-${channelId}`);
  const index = new Document({
    document: {
      id: 'id',
      index: [{ field: 'content', tokenize: 'forward' }],
      store: [
        'id',
        'channelId',
        'authorId',
        'createdAt',
        'hasAttachment',
        'hasMention',
      ],
      tag: [{ field: 'channelId' }, { field: 'authorId' }],
    },
    resolution: 5,
    commit: false,
  });
  await index.mount(db);
  indexes.set(channelId, index);
  dbs.set(channelId, db);
  touchChannel(channelId);
  await evictIfNeeded();
}

async function initChannel(channelId: string): Promise<void> {
  if (indexes.has(channelId)) {
    touchChannel(channelId);
    return;
  }
  const existing = initializing.get(channelId);
  if (existing) return existing;
  const promise = doInit(channelId);
  initializing.set(channelId, promise);
  try {
    await promise;
  } finally {
    initializing.delete(channelId);
  }
}

function enqueue(channelId: string, fn: () => Promise<void>): Promise<void> {
  const prev = channelQueues.get(channelId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  channelQueues.set(channelId, next);
  return next;
}

function scheduleCommit(channelId: string): void {
  dirtyChannels.add(channelId);
  pendingMutations++;
  if (pendingMutations >= COMMIT_BATCH_THRESHOLD) {
    flushDirty();
    return;
  }
  if (commitTimer) return;
  commitTimer = setTimeout(() => {
    commitTimer = null;
    flushDirty();
  }, COMMIT_INTERVAL_MS);
}

async function flushDirty(): Promise<void> {
  pendingMutations = 0;
  const channels = [...dirtyChannels];
  dirtyChannels.clear();
  await Promise.allSettled(channels.map((id) => indexes.get(id)?.commit()));
}

async function addMessages(
  channelId: string,
  msgs: IndexableMessage[],
): Promise<number> {
  return enqueue(channelId, async () => {
    await initChannel(channelId);
    const index = indexes.get(channelId);
    if (!index) return;

    const CHUNK_SIZE = 500;
    for (let i = 0; i < msgs.length; i += CHUNK_SIZE) {
      const chunk = msgs.slice(i, i + CHUNK_SIZE);
      for (const msg of chunk) index.add(msg as unknown as DocumentData);
      // Yield to allow other worker messages to be processed
      if (i + CHUNK_SIZE < msgs.length) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
    scheduleCommit(channelId);
  }).then(() => msgs.length);
}

async function updateMessage(
  channelId: string,
  msg: IndexableMessage,
): Promise<void> {
  return enqueue(channelId, async () => {
    await initChannel(channelId);
    const index = indexes.get(channelId);
    if (!index) return;
    index.update(msg as unknown as DocumentData);
    scheduleCommit(channelId);
  });
}

async function removeMessage(channelId: string, msgId: string): Promise<void> {
  return enqueue(channelId, async () => {
    const index = indexes.get(channelId);
    if (!index) return;
    index.remove(msgId);
    scheduleCommit(channelId);
  });
}

async function removeMessages(
  channelId: string,
  msgIds: string[],
): Promise<void> {
  return enqueue(channelId, async () => {
    const index = indexes.get(channelId);
    if (!index) return;
    for (const id of msgIds) index.remove(id);
    scheduleCommit(channelId);
  });
}

async function search(query: string, opts: SearchOpts): Promise<SearchHit[]> {
  const channelIds = opts.channelId ? [opts.channelId] : [...indexes.keys()];

  const limit = opts.limit ?? 25;
  const results: SearchHit[] = [];
  const seen = new Set<string>();

  for (const id of channelIds) {
    const idx = indexes.get(id);
    if (!idx) continue;

    const hits = await idx.search({
      query,
      tag: opts.authorId ? { authorId: opts.authorId } : undefined,
      limit,
      enrich: true,
    });

    for (const field of hits) {
      for (const hit of field.result) {
        const doc = hit.doc as Record<string, unknown> | undefined;
        if (!doc || seen.has(doc.id as string)) continue;
        seen.add(doc.id as string);

        const createdAt = doc.createdAt as number;
        if (opts.before && createdAt >= opts.before) continue;
        if (opts.after && createdAt <= opts.after) continue;
        if (opts.hasAttachment && !(doc.hasAttachment as boolean)) continue;

        results.push({
          id: doc.id as string,
          channelId: doc.channelId as string,
          authorId: doc.authorId as string,
          createdAt,
          hasAttachment: doc.hasAttachment as boolean,
          hasMention: doc.hasMention as boolean,
        });
      }
    }
  }

  return results.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
}

async function warmChannels(channelIds: string[]): Promise<void> {
  const cold = channelIds.filter((id) => !indexes.has(id));
  await Promise.all(cold.slice(0, 5).map((id) => initChannel(id)));
}

async function clearChannel(channelId: string): Promise<void> {
  return enqueue(channelId, async () => {
    const index = indexes.get(channelId);
    if (index) {
      try {
        await index.clear();
        await index.destroy();
      } catch {
        // best effort
      }
    }
    indexes.delete(channelId);
    dbs.delete(channelId);
    const i = accessOrder.indexOf(channelId);
    if (i !== -1) accessOrder.splice(i, 1);
  });
}

async function clearAll(): Promise<void> {
  const channelIds = [...indexes.keys()];
  await Promise.all(channelIds.map((id) => clearChannel(id)));
}

// RPC handler
// biome-ignore lint/suspicious/noExplicitAny: dynamic dispatch requires untyped args
const methods: Record<string, (...args: any[]) => Promise<unknown>> = {
  initChannel: (id: string) => initChannel(id),
  addMessages: (id: string, msgs: IndexableMessage[]) => addMessages(id, msgs),
  updateMessage: (id: string, msg: IndexableMessage) => updateMessage(id, msg),
  removeMessage: (id: string, msgId: string) => removeMessage(id, msgId),
  removeMessages: (id: string, msgIds: string[]) => removeMessages(id, msgIds),
  search: (query: string, opts: SearchOpts) => search(query, opts),
  warmChannels: (ids: string[]) => warmChannels(ids),
  clearChannel: (id: string) => clearChannel(id),
  clearAll: () => clearAll(),
};

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const { id, method, args } = event.data;
  try {
    const fn = methods[method];
    if (!fn) throw new Error(`Unknown method: ${method}`);
    const result = await fn(...args);
    self.postMessage({ id, result } as WorkerResponse);
  } catch (err) {
    self.postMessage({
      id,
      error: err instanceof Error ? err.message : 'Worker error',
    } as WorkerResponse);
  }
};

// Flush dirty indexes before worker is terminated
self.addEventListener('beforeunload', () => flushDirty());
