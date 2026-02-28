import { logError } from './log.ts';

/**
 * Wait for an HTTP service to become available.
 * Polls with exponential backoff until timeout.
 */
export async function waitForService(
  port: number,
  name: string,
  timeoutMs = 60_000,
): Promise<void> {
  const start = Date.now();
  let delay = 100;

  while (Date.now() - start < timeoutMs) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);
      await fetch(`http://localhost:${port}/`, { signal: controller.signal });
      clearTimeout(timeout);
      return;
    } catch {
      // ConnectRPC services return errors for GET /, but the connection succeeding
      // means the service is up. We catch both network errors and HTTP errors.
    }

    // Check if we got a connection (even a 404 means the service is listening)
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);
      const resp = await fetch(`http://localhost:${port}/`, {
        method: 'POST',
        signal: controller.signal,
      });
      clearTimeout(timeout);
      // Any response means the service is listening
      return;
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        // Timeout, try again
      } else if (
        err instanceof TypeError &&
        'cause' in err &&
        (err.cause as { code?: string })?.code === 'ECONNREFUSED'
      ) {
        // Service not up yet, wait
      } else {
        // Some other error, but connection attempt didn't get ECONNREFUSED,
        // so the service might be up
        return;
      }
    }

    await sleep(delay);
    delay = Math.min(delay * 2, 2000);
  }

  logError(`${name} not ready after ${Math.round(timeoutMs / 1000)}s on port ${port}`);
  process.exit(1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
