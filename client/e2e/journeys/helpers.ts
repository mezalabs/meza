import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Browser, BrowserContext, Page, TestInfo } from '@playwright/test';

// ---------------------------------------------------------------------------
// Failure tracking
// ---------------------------------------------------------------------------

type StepFailure = {
  step: string;
  error: string;
  screenshot?: string;
};

const failures: StepFailure[] = [];

/**
 * Chapter — a group of dependent steps. If any step within the chapter's
 * callback throws, the error is captured (with a screenshot) and the rest
 * of the chapter is skipped. Execution continues to the next chapter.
 */
export async function chapter(
  page: Page,
  testInfo: TestInfo,
  name: string,
  fn: () => Promise<void>,
) {
  await testInfo.attach(`chapter: ${name}`, {
    contentType: 'text/plain',
    body: `Starting chapter: ${name}`,
  });
  try {
    await fn();
  } catch (err) {
    const screenshotDir = path.join(testInfo.outputDir, 'screenshots');
    fs.mkdirSync(screenshotDir, { recursive: true });
    const screenshotPath = path.join(
      screenshotDir,
      `${name.replace(/\W+/g, '-')}-${Date.now()}.png`,
    );
    await page.screenshot({ path: screenshotPath }).catch(() => {});
    const message = err instanceof Error ? err.message : String(err);
    failures.push({
      step: `[chapter] ${name}`,
      error: message,
      screenshot: screenshotPath,
    });
    await testInfo.attach(`FAILED: ${name}`, {
      contentType: 'text/plain',
      body: message,
    });
  }
}

/**
 * Soft step — an independent edge-case check. If it fails, the error is
 * captured and execution continues without affecting subsequent steps.
 */
export async function softStep(
  page: Page,
  testInfo: TestInfo,
  name: string,
  fn: () => Promise<void>,
) {
  try {
    await fn();
  } catch (err) {
    const screenshotDir = path.join(testInfo.outputDir, 'screenshots');
    fs.mkdirSync(screenshotDir, { recursive: true });
    const screenshotPath = path.join(
      screenshotDir,
      `${name.replace(/\W+/g, '-')}-${Date.now()}.png`,
    );
    await page.screenshot({ path: screenshotPath }).catch(() => {});
    const message = err instanceof Error ? err.message : String(err);
    failures.push({
      step: `[soft] ${name}`,
      error: message,
      screenshot: screenshotPath,
    });
    await testInfo.attach(`SOFT FAIL: ${name}`, {
      contentType: 'text/plain',
      body: message,
    });
  }
}

/**
 * Call at the end of each journey. If any chapters or soft steps failed,
 * throws a summary error so the overall test reports failure.
 */
export function reportFailures() {
  if (failures.length === 0) return;
  const summary = failures.map((f) => `  - ${f.step}: ${f.error}`).join('\n');
  // Reset for next journey
  const count = failures.length;
  failures.length = 0;
  throw new Error(`${count} step(s) failed:\n${summary}`);
}

// ---------------------------------------------------------------------------
// Multi-user context management
// ---------------------------------------------------------------------------

/**
 * Create a new browser context and page. If a storage state file exists at
 * `.auth/{name}.json`, it will be loaded automatically. Also restores the
 * E2EE session (master key + encrypted key bundle) that Playwright's
 * storageState does not persist (sessionStorage and IndexedDB).
 */
export async function createContext(
  browser: Browser,
  name: string,
): Promise<{ context: BrowserContext; page: Page }> {
  const authFile = `.auth/${name}.json`;
  const cryptoFile = `.auth/${name}-crypto.json`;
  const hasAuth = fs.existsSync(authFile);
  const context = await browser.newContext(
    hasAuth ? { storageState: authFile } : undefined,
  );
  const page = await context.newPage();

  // Restore E2EE crypto state (master key → sessionStorage, key bundle → IndexedDB).
  // Playwright storageState only persists localStorage/cookies.
  if (fs.existsSync(cryptoFile)) {
    const crypto = JSON.parse(fs.readFileSync(cryptoFile, 'utf-8'));

    // Restore sessionStorage master key on every page load.
    await page.addInitScript((mk: string) => {
      sessionStorage.setItem('meza-mk', mk);
    }, crypto.mk);

    // Write the encrypted key bundle to IndexedDB BEFORE the app loads.
    // Navigate to a static asset on the same origin (so IndexedDB is
    // accessible) without triggering the React SPA.
    if (crypto.kb) {
      await page.goto('/favicon.ico', { waitUntil: 'commit' });
      await page.evaluate(async (kb: number[]) => {
        await new Promise<void>((resolve, reject) => {
          const req = indexedDB.open('meza-crypto', 4);
          req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains('key-bundle'))
              db.createObjectStore('key-bundle', { keyPath: 'id' });
            if (!db.objectStoreNames.contains('channel-keys'))
              db.createObjectStore('channel-keys', { keyPath: 'id' });
          };
          req.onsuccess = () => {
            const db = req.result;
            const tx = db.transaction('key-bundle', 'readwrite');
            tx.objectStore('key-bundle').put({
              id: 'current',
              keyBundle: new Uint8Array(kb),
            });
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
          };
          req.onerror = () => reject(req.error);
        });
      }, crypto.kb);
    }
  }

  return { context, page };
}

/**
 * Save a browser context's storage state to `.auth/{name}.json`.
 * Also persists the E2EE crypto state (master key from sessionStorage,
 * encrypted key bundle from IndexedDB) for cross-journey restoration.
 */
export async function saveAuth(
  context: BrowserContext,
  name: string,
): Promise<void> {
  fs.mkdirSync('.auth', { recursive: true });
  await context.storageState({ path: `.auth/${name}.json` });

  // Persist E2EE crypto state that storageState doesn't cover.
  const pages = context.pages();
  if (pages.length > 0) {
    const crypto = await pages[0]
      .evaluate(async () => {
        const mk = sessionStorage.getItem('meza-mk');
        if (!mk) return null;

        // Read key bundle from IndexedDB
        const kb = await new Promise<number[] | null>((resolve) => {
          const req = indexedDB.open('meza-crypto', 4);
          req.onerror = () => resolve(null);
          req.onsuccess = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains('key-bundle')) {
              resolve(null);
              return;
            }
            const tx = db.transaction('key-bundle', 'readonly');
            const get = tx.objectStore('key-bundle').get('current');
            tx.oncomplete = () => {
              const record = get.result as
                | { keyBundle: Uint8Array }
                | undefined;
              resolve(record ? Array.from(record.keyBundle) : null);
            };
            tx.onerror = () => resolve(null);
          };
        });

        return { mk, kb };
      })
      .catch(() => null);

    if (crypto) {
      fs.writeFileSync(`.auth/${name}-crypto.json`, JSON.stringify(crypto));
    }
  }
}
