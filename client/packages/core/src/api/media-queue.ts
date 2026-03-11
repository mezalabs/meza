/**
 * Concurrency-limited media fetch semaphore.
 *
 * When a channel has many images, dozens of thumbnail requests fire at once,
 * overwhelming the server rate limiter (429). This semaphore limits concurrent
 * in-flight requests so the client stays within the server's rate budget.
 *
 * Concurrency of 6 is chosen to stay within the server's RPC rate limit
 * (10 req/s, burst 20) while keeping thumbnail loading responsive.
 */

function makeSemaphore(max: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  function release() {
    active--;
    queue.shift()?.();
  }
  return <T>(fn: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve) => {
      const run = () => {
        active++;
        resolve(fn().finally(release));
      };
      active < max ? run() : queue.push(run);
    });
}

/** Singleton semaphore — limits concurrent media fetches across the app. */
export const enqueueMedia = makeSemaphore(6);
