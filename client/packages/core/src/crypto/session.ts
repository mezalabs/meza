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
 * close, limiting the exposure window.
 *
 * Cross-tab support: when a new tab opens (sessionStorage is empty), we use
 * the BroadcastChannel API to request the session key from an existing tab.
 * If another tab responds, the new tab can decrypt the master key without
 * requiring re-authentication. If all tabs are closed (no responder), the
 * user must re-authenticate on next visit. Note: this means an XSS attacker
 * in one tab can obtain the session key via BroadcastChannel from another
 * tab without directly reading sessionStorage. The same-origin restriction
 * of BroadcastChannel limits this to scripts already running on the app's
 * origin, which could also read sessionStorage directly.
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
/** BroadcastChannel name for cross-tab session key sharing. */
const SESSION_SYNC_CHANNEL = 'meza-session-sync';
/** How long a new tab waits for a session key response from another tab. */
const SESSION_KEY_REQUEST_TIMEOUT_MS = 1_000;

// ---------------------------------------------------------------------------
// Cross-tab session sync message types
// ---------------------------------------------------------------------------

/** Messages exchanged between tabs via BroadcastChannel. */
type SessionSyncMessage =
  | { type: 'session-key-request' }
  | { type: 'session-key-response'; key: string }
  | { type: 'session-key-update'; key: string }
  | { type: 'session-teardown' };

function isSessionSyncMessage(data: unknown): data is SessionSyncMessage {
  if (typeof data !== 'object' || data === null || !('type' in data))
    return false;
  const msg = data as { type: string };
  switch (msg.type) {
    case 'session-key-request':
    case 'session-teardown':
      return true;
    case 'session-key-response':
    case 'session-key-update':
      return 'key' in data && typeof (data as { key: unknown }).key === 'string';
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Cross-tab session key sharing via BroadcastChannel
// ---------------------------------------------------------------------------

/** Active BroadcastChannel for responding to session key requests. */
let syncChannel: BroadcastChannel | null = null;

/**
 * Request the session key from another open tab. Returns the base64-encoded
 * session key if a tab responds within the timeout, or null otherwise.
 */
function requestSessionKeyFromPeer(): Promise<string | null> {
  if (typeof BroadcastChannel === 'undefined') return Promise.resolve(null);

  try {
    const ch = new BroadcastChannel(SESSION_SYNC_CHANNEL);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        ch.onmessage = null;
        ch.close();
        resolve(null);
      }, SESSION_KEY_REQUEST_TIMEOUT_MS);

      ch.onmessage = (event: MessageEvent) => {
        if (
          isSessionSyncMessage(event.data) &&
          event.data.type === 'session-key-response'
        ) {
          clearTimeout(timer);
          ch.onmessage = null;
          ch.close();
          resolve(event.data.key);
        }
      };

      ch.postMessage({ type: 'session-key-request' } satisfies SessionSyncMessage);
    });
  } catch {
    return Promise.resolve(null);
  }
}

/**
 * Start listening for session key requests from new tabs. Called after a
 * successful bootstrap so this tab can share its session key with peers.
 *
 * Also handles:
 * - `session-key-update`: another tab rotated the master key wrapping key
 *   (e.g. password change). Update this tab's sessionStorage so reloads
 *   can still decrypt the master key blob in localStorage.
 * - `session-teardown`: another tab logged out. Tear down the local session
 *   and notify the `onSessionTeardown` callback so the app can clear auth.
 */
function startSessionKeyResponder(): void {
  if (typeof BroadcastChannel === 'undefined') return;
  if (syncChannel) return;

  try {
    syncChannel = new BroadcastChannel(SESSION_SYNC_CHANNEL);
  } catch {
    return;
  }

  syncChannel.onmessage = (event: MessageEvent) => {
    if (!isSessionSyncMessage(event.data)) return;

    switch (event.data.type) {
      case 'session-key-request': {
        const ss = ephemeralStorage();
        const sk = ss?.getItem(SK_SESSION_KEY);
        if (sk) {
          syncChannel?.postMessage({
            type: 'session-key-response',
            key: sk,
          } satisfies SessionSyncMessage);
        }
        break;
      }

      case 'session-key-update': {
        // Another tab rotated the session wrapping key — update ours so
        // page reloads can still decrypt the master key from localStorage.
        const ss = ephemeralStorage();
        if (ss) ss.setItem(SK_SESSION_KEY, event.data.key);
        break;
      }

      case 'session-teardown': {
        // Another tab logged out — tear down our session too.
        // Pass broadcast=false to avoid re-broadcasting back.
        teardownSession(false).then(() => {
          for (const cb of teardownListeners) cb();
        });
        break;
      }
    }
  };
}

/** Stop the session key responder (on teardown). */
function stopSessionKeyResponder(): void {
  if (syncChannel) {
    syncChannel.close();
    syncChannel = null;
  }
}

/**
 * Broadcast a session-key-update to all other tabs so they update their
 * sessionStorage with the new wrapping key after master key re-encryption.
 */
function broadcastSessionKeyUpdate(sessionKeyBase64: string): void {
  if (typeof BroadcastChannel === 'undefined') return;
  try {
    const ch = new BroadcastChannel(SESSION_SYNC_CHANNEL);
    ch.postMessage({
      type: 'session-key-update',
      key: sessionKeyBase64,
    } satisfies SessionSyncMessage);
    ch.close();
  } catch {
    // Best-effort — BroadcastChannel may not be available
  }
}

/**
 * Broadcast a session-teardown to all other tabs so they log out too.
 */
function broadcastSessionTeardown(): void {
  if (typeof BroadcastChannel === 'undefined') return;
  try {
    const ch = new BroadcastChannel(SESSION_SYNC_CHANNEL);
    ch.postMessage({ type: 'session-teardown' } satisfies SessionSyncMessage);
    ch.close();
  } catch {
    // Best-effort
  }
}

// ---------------------------------------------------------------------------
// Cross-tab teardown notification
// ---------------------------------------------------------------------------

const teardownListeners: Array<() => void> = [];

/**
 * Register a callback that fires when another tab broadcasts a session
 * teardown (logout). The app should call `clearAuth()` in response.
 * Returns an unsubscribe function.
 */
export function onCrossTabTeardown(cb: () => void): () => void {
  teardownListeners.push(cb);
  return () => {
    const idx = teardownListeners.indexOf(cb);
    if (idx >= 0) teardownListeners.splice(idx, 1);
  };
}

// ---------------------------------------------------------------------------
// Helpers: storage accessors
// ---------------------------------------------------------------------------

function persistentStorage(): Storage | undefined {
  if (typeof localStorage === 'undefined') return undefined;
  return localStorage;
}

function ephemeralStorage(): Storage | undefined {
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

  const sessionKeyBase64 = toBase64(sessionKey);
  ss.setItem(SK_SESSION_KEY, sessionKeyBase64);
  ls.setItem(MK_STORAGE_KEY, toBase64(blob));

  // Notify other tabs so they update their sessionStorage with the new key
  broadcastSessionKeyUpdate(sessionKeyBase64);
}

/**
 * Decrypt the master key from localStorage using the session key in
 * sessionStorage. If sessionStorage is empty (new tab), attempts to
 * request the session key from another open tab via BroadcastChannel.
 * Returns `null` if no session key is available, which forces
 * re-authentication.
 */
async function loadMasterKey(): Promise<Uint8Array | null> {
  const ls = persistentStorage();
  const ss = ephemeralStorage();
  if (!ls || !ss) return null;

  const storedBlob = ls.getItem(MK_STORAGE_KEY);
  if (!storedBlob) return null;

  let storedSk = ss.getItem(SK_SESSION_KEY);

  // New tab: sessionStorage is empty. Ask another open tab for the session key.
  if (!storedSk) {
    const peerKey = await requestSessionKeyFromPeer();
    if (!peerKey) return null;
    storedSk = peerKey;
  }

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

    // Only persist the session key after successful decryption — prevents
    // a poisoned BroadcastChannel response from causing persistent failures.
    ss.setItem(SK_SESSION_KEY, storedSk);

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

  // Start responding to session key requests from new tabs
  startSessionKeyResponder();

  // Notify any hooks waiting for the session to become ready
  for (const cb of readyListeners) cb();
  readyListeners.length = 0;

  return true;
}

/**
 * Tear down the E2EE session (on logout).
 *
 * @param broadcast - If true (default), notify other tabs to tear down too.
 *   Set to false when responding to a cross-tab teardown to avoid loops.
 */
export async function teardownSession(broadcast = true): Promise<void> {
  // Only broadcast if we have an active session — prevents re-broadcasting
  // when the auth store subscription triggers a second teardown after
  // a cross-tab teardown callback calls clearAuth().
  if (broadcast && sessionReady) broadcastSessionTeardown();

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
  stopSessionKeyResponder();
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
