/**
 * E2EE session lifecycle.
 *
 * Initializes the identity keypair and channel key cache after authentication.
 * Call `bootstrapSession()` after login/registration or on app reload
 * when the user is already authenticated.
 *
 * The master key is cached so the encrypted key bundle in IndexedDB can be
 * decrypted without re-entering the password:
 *   - Web: sessionStorage (survives reload, cleared on tab close)
 *   - Mobile (Capacitor): sessionStorage (survives reload within same WebView
 *     lifecycle; cleared when OS kills the process, requiring re-login)
 *
 * NOTE: We intentionally use sessionStorage on all platforms. On mobile,
 * the OS may kill the process and clear the key, but using localStorage
 * would persist the master key in plaintext on disk indefinitely — an
 * unacceptable risk for the most sensitive secret in the E2EE system.
 * When Capacitor Secure Storage or iOS Keychain integration is added,
 * mobile can use that for persistence across process restarts.
 */

import {
  clearChannelKeyCache,
  flushChannelKeys,
  initChannelKeys,
  loadCachedChannelKeys,
} from './channel-keys.ts';
import { restoreIdentity } from './credentials.ts';
import type { IdentityKeypair } from './primitives.ts';
import { clearAesKeyCache } from './primitives.ts';
import { clearCryptoStorage } from './storage.ts';

let sessionReady = false;
let bootstrapPromise: Promise<boolean> | null = null;
let identity: IdentityKeypair | null = null;
const readyListeners: Array<() => void> = [];

const MK_SESSION_KEY = 'meza-mk';

function mkStorage(): Storage | undefined {
  if (typeof sessionStorage === 'undefined') return undefined;
  return sessionStorage;
}

function storeMasterKey(key: Uint8Array): void {
  const storage = mkStorage();
  if (!storage) return;
  let binary = '';
  for (let i = 0; i < key.length; i++) {
    binary += String.fromCharCode(key[i]);
  }
  storage.setItem(MK_SESSION_KEY, btoa(binary));
}

function loadMasterKey(): Uint8Array | null {
  const storage = mkStorage();
  if (!storage) return null;
  const stored = storage.getItem(MK_SESSION_KEY);
  if (!stored) return null;
  return Uint8Array.from(atob(stored), (c) => c.charCodeAt(0));
}

function clearMasterKey(): void {
  const storage = mkStorage();
  if (!storage) return;
  storage.removeItem(MK_SESSION_KEY);
}

/**
 * Bootstrap the E2EE session from the encrypted key bundle in IndexedDB.
 *
 * If a masterKey is provided (login/registration), it's used to decrypt the
 * key bundle and cached in sessionStorage for page reloads. On page reload,
 * the cached master key from sessionStorage is used.
 *
 * Returns true if the session was initialized, false if unable to decrypt.
 */
export async function bootstrapSession(
  masterKey?: Uint8Array,
): Promise<boolean> {
  if (sessionReady) return true;
  if (bootstrapPromise) return bootstrapPromise;

  bootstrapPromise = doBootstrap(masterKey).finally(() => {
    bootstrapPromise = null;
  });
  return bootstrapPromise;
}

async function doBootstrap(masterKey?: Uint8Array): Promise<boolean> {
  if (sessionReady) return true;

  const key = masterKey ?? loadMasterKey();
  if (!key) return false;

  const restored = await restoreIdentity(key);
  if (!restored) return false;

  // Cache master key in sessionStorage for page reloads
  if (masterKey) storeMasterKey(masterKey);

  identity = restored;

  // Initialize channel keys module with identity + master key
  initChannelKeys(restored, key);

  // Load cached channel keys from IndexedDB
  try {
    await loadCachedChannelKeys();
  } catch (err) {
    console.error('[E2EE] loadCachedChannelKeys failed:', err);
  }

  sessionReady = true;

  // Notify any hooks waiting for the session to become ready
  for (const cb of readyListeners) cb();
  readyListeners.length = 0;

  return true;
}

/**
 * Tear down the E2EE session (on logout).
 */
export async function teardownSession(): Promise<void> {
  // Flush any pending channel key persistence
  try {
    await flushChannelKeys();
  } catch {
    // Best-effort
  }
  // Clear search indexes and terminate worker
  try {
    const { resetSearchState } = await import('../search/indexer.ts');
    await resetSearchState();
  } catch {
    // Best-effort — search module may not be loaded
  }
  clearChannelKeyCache();
  clearAesKeyCache();
  clearMasterKey();
  // Wipe IndexedDB crypto state (encrypted bundles + channel key cache)
  try {
    await clearCryptoStorage();
  } catch {
    // Best-effort — IndexedDB may not be available
  }
  identity = null;
  sessionReady = false;
  readyListeners.length = 0;
}

/**
 * Check if the E2EE session is initialized.
 */
export function isSessionReady(): boolean {
  return sessionReady;
}

/**
 * Get the current identity keypair. Returns null if session is not ready.
 */
export function getIdentity(): IdentityKeypair | null {
  return identity;
}

/**
 * Register a callback that fires when the E2EE session becomes ready.
 * If the session is already ready, the callback is invoked synchronously.
 * Returns an unsubscribe function.
 */
export function onSessionReady(cb: () => void): () => void {
  if (sessionReady) {
    cb();
    return () => {};
  }
  readyListeners.push(cb);
  return () => {
    const idx = readyListeners.indexOf(cb);
    if (idx >= 0) readyListeners.splice(idx, 1);
  };
}
