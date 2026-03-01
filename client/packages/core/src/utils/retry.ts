/**
 * Retry an async function with exponential backoff and full jitter.
 *
 * Uses "full jitter" strategy: uniform random in [0, min(cap, base * 2^attempt)]
 * to prevent thundering herd across multiple tabs/clients.
 * @see https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  opts: {
    maxAttempts: number;
    initialDelayMs: number;
    maxDelayMs?: number;
    shouldRetry?: (error: unknown) => boolean;
    onRetry?: (attempt: number, delayMs: number) => void;
    signal?: { cancelled: boolean };
  },
): Promise<T> {
  const {
    maxAttempts,
    initialDelayMs,
    maxDelayMs = 30_000,
    shouldRetry,
    onRetry,
    signal,
  } = opts;
  if (maxAttempts < 1) throw new Error('maxAttempts must be >= 1');

  let delay = initialDelayMs;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (signal?.cancelled) throw new Error('Cancelled');
    try {
      const result = await fn();
      if (signal?.cancelled) throw new Error('Cancelled');
      return result;
    } catch (err) {
      if (signal?.cancelled) throw err;
      if (attempt === maxAttempts) throw err;
      if (shouldRetry && !shouldRetry(err)) throw err;
      const jitteredDelay = Math.floor(Math.random() * delay);
      if (onRetry) onRetry(attempt, jitteredDelay);
      await new Promise((r) => setTimeout(r, jitteredDelay));
      if (signal?.cancelled) throw err;
      delay = Math.min(delay * 2, maxDelayMs);
    }
  }
  throw new Error('unreachable');
}
