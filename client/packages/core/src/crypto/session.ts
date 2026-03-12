/**
 * E2EE session lifecycle.
 *
 * Initializes the identity keypair and channel key cache after authentication.
 * Call `bootstrapSession()` after login/registration or on app reload
 * when the user is already authenticated.
 *
 * The master key is cached in localStorage so the encrypted key bundle in
 * IndexedDB can be decrypted without re-entering the password on page
 * reload or app restart (including Capacitor mobile shells).
 *
 * Security: the master key is never stored in plaintext. A random session
 * key held in sessionStorage encrypts (AES-256-GCM) the master key before
 * it is persisted to localStorage. An XSS attacker must access both storage
 * mechanisms to recover the master key; sessionStorage is cleared on tab
 * close, limiting the exposure window. If the session key is missing (new
 * tab / tab closed), the user must re-authenticate.
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

/** localStorage key for the AES-256-GCM encrypted master key blob. */
const MK_STORAGE_KEY = 'meza-mk';
/** sessionStorage key for the ephemeral session wrapping key. */
const SK_SESSION_KEY = 'meza-sk';

// ---------------------------------------------------------------------------
// Helpers: storage accessors
// ---------------------------------------------------------------------------

function persistentStorage(): Storage | undefined {
  if (typeof localStorage === 'undefined') return undefined;
  return localStorage;
}

function ephemeralStorage(): Storage | undefined {
  // In Electron, sessionStorage is cleared on app quit — use localStorage
  // instead. The sessionStorage/localStorage split only protects against
  // cross-tab XSS on the web, which doesn't apply to a desktop app.
  if (typeof window !== 'undefined' && 'electronAPI' in window) {
    return typeof localStorage !== 'undefined' ? localStorage : undefined;
  }
  if (typeof sessionStorage === 'undefined') return undefined;
  return sessionStorage;
}

// ---------------------------------------------------------------------------
// Helpers: base64 encode / decode for Uint8Array
// ---------------------------------------------------------------------------

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function fromBase64(encoded: string): Uint8Array {
  return Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
}

// ---------------------------------------------------------------------------
// Master key wrapping: AES-256-GCM with an ephemeral session key
// ---------------------------------------------------------------------------

/**
 * Encrypt `masterKey` with a random session key using AES-256-GCM.
 *
 * - The 32-byte session key is stored in **sessionStorage** (cleared on tab
 *   close) so it is not persisted to disk alongside the ciphertext.
 * - The encrypted blob (iv + ciphertext) is stored in **localStorage**.
 *
 * Format in localStorage: base64( iv(12) || ciphertext(32 + 16 GCM tag) )
 */
async function storeMasterKey(key: Uint8Array): Promise<void> {
  const ls = persistentStorage();
  const ss = ephemeralStorage();
  if (!ls || !ss) return;

  // Generate a fresh 32-byte session wrapping key
  const sessionKey = crypto.getRandomValues(new Uint8Array(32));

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    sessionKey as BufferSource,
    'AES-GCM',
    false,
    ['encrypt'],
  );

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      cryptoKey,
      key as BufferSource,
    ),
  );

  // Pack iv || ciphertext
  const blob = new Uint8Array(iv.length + ciphertext.length);
  blob.set(iv, 0);
  blob.set(ciphertext, 12);

  ss.setItem(SK_SESSION_KEY, toBase64(sessionKey));
  ls.setItem(MK_STORAGE_KEY, toBase64(blob));
}

/**
 * Decrypt the master key from localStorage using the session key in
 * sessionStorage. Returns `null` if either piece is missing (e.g. new tab
 * or cleared session), which forces re-authentication.
 */
async function loadMasterKey(): Promise<Uint8Array | null> {
  const ls = persistentStorage();
  const ss = ephemeralStorage();
  if (!ls || !ss) return null;

  const storedBlob = ls.getItem(MK_STORAGE_KEY);
  const storedSk = ss.getItem(SK_SESSION_KEY);
  if (!storedBlob || !storedSk) return null;

  try {
    const blob = fromBase64(storedBlob);
    const sessionKeyBytes = fromBase64(storedSk);

    // blob = iv(12) || ciphertext(48)
    if (blob.length < 28) return null; // too short to be valid

    const iv = blob.slice(0, 12);
    const ciphertext = blob.slice(12);

    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      sessionKeyBytes as BufferSource,
      'AES-GCM',
      false,
      ['decrypt'],
    );

    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      cryptoKey,
      ciphertext as BufferSource,
    );

    return new Uint8Array(plaintext);
  } catch {
    // Decryption failure — session key mismatch or tampered blob
    return null;
  }
}

function clearMasterKey(): void {
  const ls = persistentStorage();
  if (ls) ls.removeItem(MK_STORAGE_KEY);
  const ss = ephemeralStorage();
  if (ss) ss.removeItem(SK_SESSION_KEY);
}

/**
 * Bootstrap the E2EE session from the encrypted key bundle in IndexedDB.
 *
 * If a masterKey is provided (login/registration), it's used to decrypt the
 * key bundle and cached in localStorage for page reloads. On page reload,
 * the cached master key from localStorage is used.
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

  const key = masterKey ?? (await loadMasterKey());
  if (!key) return false;

  const restored = await restoreIdentity(key);
  if (!restored) return false;

  // Cache master key (encrypted) in localStorage for page reloads
  if (masterKey) await storeMasterKey(masterKey);

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
