// search-service.ts — main thread wrapper for the search worker
import type {
  IndexableMessage,
  SearchHit,
  SearchOpts,
  WorkerRequest,
  WorkerResponse,
} from './types.ts';

let worker: Worker | null = null;
let nextId = 0;
const pending = new Map<
  number,
  { resolve: (v: unknown) => void; reject: (e: Error) => void }
>();

function getWorker(): Worker {
  if (!worker) {
    // Worker is not available in test/SSR environments
    if (typeof Worker === 'undefined') {
      throw new Error('Web Workers are not available in this environment');
    }
    worker = new Worker(new URL('./search-worker.ts', import.meta.url), {
      type: 'module',
    });
    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      if ('error' in e.data) p.reject(new Error(e.data.error));
      else p.resolve(e.data.result);
    };
  }
  return worker;
}

function call<T>(method: string, args: unknown[]): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    getWorker().postMessage({ id, method, args });
  });
}

export function initSearchChannel(id: string): Promise<void> {
  return call('initChannel', [id]);
}

export function addSearchMessages(
  id: string,
  msgs: IndexableMessage[],
): Promise<number> {
  return call('addMessages', [id, msgs]);
}

export function updateSearchMessage(
  id: string,
  msg: IndexableMessage,
): Promise<void> {
  return call('updateMessage', [id, msg]);
}

export function removeSearchMessage(id: string, msgId: string): Promise<void> {
  return call('removeMessage', [id, msgId]);
}

export function removeSearchMessages(
  id: string,
  msgIds: string[],
): Promise<void> {
  return call('removeMessages', [id, msgIds]);
}

export function searchIndex(
  query: string,
  opts: SearchOpts,
): Promise<SearchHit[]> {
  return call('search', [query, opts]);
}

export function warmSearchChannels(ids: string[]): Promise<void> {
  return call('warmChannels', [ids]);
}

export function clearSearchChannel(id: string): Promise<void> {
  return call('clearChannel', [id]);
}

export function clearAllSearchIndexes(): Promise<void> {
  return call('clearAll', []);
}

export function terminateSearchWorker(): void {
  if (worker) {
    worker.terminate();
    worker = null;
  }
  pending.clear();
}
