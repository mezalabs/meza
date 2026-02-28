/**
 * E2EE session lifecycle.
 *
 * Initializes the identity keypair and channel key cache after authentication.
 * Call `bootstrapSession()` after login/registration or on app reload
 * when the user is already authenticated.
 *
 * The master key is stored in sessionStorage (survives page reload, cleared
 * on tab close) so the encrypted key bundle in IndexedDB can be decrypted
 * without re-entering the password.
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

let sessionReady = false;
let bootstrapPromise: Promise<boolean> | null = null;
let identity: IdentityKeypair | null = null;
const readyListeners: Array<() => void> = [];

const MK_SESSION_KEY = 'meza-mk';

function storeMasterKey(key: Uint8Array): void {
  if (typeof sessionStorage === 'undefined') return;
  let binary = '';
  for (let i = 0; i < key.length; i++) {
    binary += String.fromCharCode(key[i]);
  }
  sessionStorage.setItem(MK_SESSION_KEY, btoa(binary));
}

function loadMasterKey(): Uint8Array | null {
  if (typeof sessionStorage === 'undefined') return null;
  const stored = sessionStorage.getItem(MK_SESSION_KEY);
  if (!stored) return null;
  return Uint8Array.from(atob(stored), (c) => c.charCodeAt(0));
}

function clearMasterKey(): void {
  if (typeof sessionStorage === 'undefined') return;
  sessionStorage.removeItem(MK_SESSION_KEY);
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
  clearChannelKeyCache();
  clearAesKeyCache();
  clearMasterKey();
  identity = null;
  sessionReady = false;
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
