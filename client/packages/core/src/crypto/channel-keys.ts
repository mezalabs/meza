/**
 * Channel key management for static channel key E2EE.
 *
 * Each encrypted channel has a versioned AES-256-GCM symmetric key.
 * Keys are wrapped to each member's X25519 public key via ECIES and
 * stored server-side as envelopes. This module handles the full lifecycle:
 * creation, wrapping, unwrapping, caching, distribution, and rotation.
 *
 * Cache layers: memory Map → IndexedDB (blob-encrypted) → server fetch.
 */

import {
  getKeyEnvelopes,
  listMembersWithViewChannel,
  rotateChannelKeyRpc,
  storeKeyEnvelopes,
} from '../api/keys.ts';
import { buildKeyWrapAAD } from './aad.ts';
import { aesGcmDecrypt, aesGcmEncrypt } from './keys.ts';
import type { IdentityKeypair } from './primitives.ts';
import {
  generateChannelKey,
  unwrapChannelKey,
  wrapChannelKey,
} from './primitives.ts';
import {
  clearChannelKeysStorage,
  loadChannelKeys,
  storeChannelKeys,
} from './storage.ts';

// --- Module state ---

let identityKeypair: IdentityKeypair | null = null;
let masterKey: Uint8Array | null = null;

/** channelId → (version → channelKey) */
const channelKeyCache = new Map<string, Map<number, Uint8Array>>();

let persistTimeout: ReturnType<typeof setTimeout> | null = null;
const PERSIST_DEBOUNCE_MS = 100;

/** In-flight fetch deduplication: channelId → pending promise */
const fetchInFlight = new Map<string, Promise<void>>();

/** In-flight lazy-init deduplication: channelId → pending promise */
const lazyInitInFlight = new Map<string, Promise<boolean>>();

// --- Initialization ---

/**
 * Initialize the channel keys module with the user's identity and master key.
 * Called from session.ts during bootstrap.
 */
export function initChannelKeys(
  identity: IdentityKeypair,
  mk: Uint8Array,
): void {
  identityKeypair = identity;
  masterKey = mk;
}

/**
 * Clear all channel key state (on logout).
 */
export function clearChannelKeyCache(): void {
  if (persistTimeout) {
    clearTimeout(persistTimeout);
    persistTimeout = null;
  }
  channelKeyCache.clear();
  fetchInFlight.clear();
  lazyInitInFlight.clear();
  identityKeypair = null;
  masterKey = null;
}

// --- Persistence (IndexedDB, blob-encrypted) ---

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function serializeCache(): Uint8Array {
  const obj: Record<string, Record<string, string>> = {};
  for (const [channelId, versionMap] of channelKeyCache) {
    const versions: Record<string, string> = {};
    for (const [version, key] of versionMap) {
      versions[String(version)] = bytesToBase64(key);
    }
    obj[channelId] = versions;
  }
  return new TextEncoder().encode(JSON.stringify(obj));
}

function deserializeCache(data: Uint8Array): void {
  const json = new TextDecoder().decode(data);
  const obj = JSON.parse(json) as Record<string, Record<string, string>>;
  for (const [channelId, versions] of Object.entries(obj)) {
    const versionMap = new Map<number, Uint8Array>();
    for (const [version, keyB64] of Object.entries(versions)) {
      versionMap.set(Number(version), base64ToBytes(keyB64));
    }
    channelKeyCache.set(channelId, versionMap);
  }
}

async function persistToStorage(): Promise<void> {
  if (!masterKey) return;
  const plaintext = serializeCache();
  const { ciphertext, iv } = await aesGcmEncrypt(masterKey, plaintext);
  await storeChannelKeys(ciphertext, iv);
}

function schedulePersist(): void {
  if (persistTimeout) clearTimeout(persistTimeout);
  persistTimeout = setTimeout(() => {
    persistTimeout = null;
    persistToStorage().catch((err) =>
      console.error('[E2EE] Failed to persist channel keys:', err),
    );
  }, PERSIST_DEBOUNCE_MS);
}

/**
 * Flush any pending debounced persist immediately.
 * Call before session teardown to avoid data loss.
 */
export async function flushChannelKeys(): Promise<void> {
  if (persistTimeout) {
    clearTimeout(persistTimeout);
    persistTimeout = null;
  }
  if (masterKey && channelKeyCache.size > 0) {
    await persistToStorage();
  }
}

/**
 * Load cached channel keys from IndexedDB into memory.
 * Called during session bootstrap.
 */
export async function loadCachedChannelKeys(): Promise<void> {
  if (!masterKey) return;
  const stored = await loadChannelKeys();
  if (!stored) return;
  try {
    const plaintext = await aesGcmDecrypt(
      masterKey,
      stored.encryptedKeys,
      stored.iv,
    );
    deserializeCache(plaintext);
  } catch (err) {
    console.error('[E2EE] Failed to decrypt cached channel keys:', err);
    // Clear the stale/corrupt cache so we don't retry on every startup.
    await clearChannelKeysStorage().catch(() => {});
  }
}

// --- Cache helpers ---

const MAX_VERSIONS_PER_CHANNEL = 3;

function setCachedKey(
  channelId: string,
  version: number,
  key: Uint8Array,
): void {
  let versionMap = channelKeyCache.get(channelId);
  if (!versionMap) {
    versionMap = new Map();
    channelKeyCache.set(channelId, versionMap);
  }
  versionMap.set(version, key);

  // Prune old versions beyond retention limit
  if (versionMap.size > MAX_VERSIONS_PER_CHANNEL) {
    const versions = [...versionMap.keys()].sort((a, b) => a - b);
    const toRemove = versions.slice(
      0,
      versions.length - MAX_VERSIONS_PER_CHANNEL,
    );
    for (const v of toRemove) {
      versionMap.delete(v);
    }
  }
}

// --- Public API ---

/**
 * Check if we have any key for a channel.
 */
export function hasChannelKey(channelId: string): boolean {
  const versionMap = channelKeyCache.get(channelId);
  return !!versionMap && versionMap.size > 0;
}

/**
 * Get the latest key version number for a channel, or null if none cached.
 */
export function getLatestKeyVersion(channelId: string): number | null {
  const versionMap = channelKeyCache.get(channelId);
  if (!versionMap || versionMap.size === 0) return null;
  let max = 0;
  for (const v of versionMap.keys()) {
    if (v > max) max = v;
  }
  return max;
}

/**
 * Get a channel key by version. Falls back to server fetch if not cached.
 */
export async function getChannelKey(
  channelId: string,
  version: number,
): Promise<Uint8Array> {
  const versionMap = channelKeyCache.get(channelId);
  if (versionMap) {
    const key = versionMap.get(version);
    if (key) return key;
  }

  // Not in cache — fetch from server
  await fetchAndCacheChannelKeys(channelId);

  const key = channelKeyCache.get(channelId)?.get(version);
  if (!key) {
    throw new Error(`Channel key not available: ${channelId} v${version}`);
  }
  return key;
}

/**
 * Generate a new channel key (version 1) and cache it locally.
 * The caller is responsible for wrapping and uploading envelopes.
 */
export function createChannelKey(channelId: string): {
  key: Uint8Array;
  version: number;
} {
  const key = generateChannelKey();
  const version = 1;
  setCachedKey(channelId, version, key);
  schedulePersist();
  return { key, version };
}

/**
 * Wrap a channel key for multiple members using ECIES.
 * Returns envelopes ready for upload via StoreKeyEnvelopes RPC.
 */
export async function wrapKeyForMembers(
  channelId: string,
  channelKey: Uint8Array,
  memberPublicKeys: Map<string, Uint8Array>,
): Promise<Array<{ userId: string; envelope: Uint8Array }>> {
  return Promise.all(
    [...memberPublicKeys.entries()].map(async ([userId, edPub]) => ({
      userId,
      envelope: await wrapChannelKey(
        channelKey,
        edPub,
        buildKeyWrapAAD(channelId, edPub),
      ),
    })),
  );
}

/**
 * Fetch channel key envelopes from the server, unwrap, and cache.
 * Concurrent calls for the same channel are coalesced into a single fetch.
 */
export function fetchAndCacheChannelKeys(channelId: string): Promise<void> {
  const existing = fetchInFlight.get(channelId);
  if (existing) return existing;

  const promise = doFetchAndCache(channelId).finally(() => {
    fetchInFlight.delete(channelId);
  });
  fetchInFlight.set(channelId, promise);
  return promise;
}

async function doFetchAndCache(channelId: string): Promise<void> {
  if (!identityKeypair) {
    throw new Error('Channel keys not initialized');
  }

  const envelopes = await getKeyEnvelopes(channelId);
  if (envelopes.length === 0) return;

  for (const { keyVersion, envelope } of envelopes) {
    const aad = buildKeyWrapAAD(channelId, identityKeypair.publicKey);
    const key = await unwrapChannelKey(
      envelope,
      identityKeypair.secretKey,
      aad,
    );
    setCachedKey(channelId, keyVersion, key);
  }
  schedulePersist();
}

/**
 * Distribute the current channel key to a new member.
 * Wraps the latest key version and uploads the envelope.
 */
export async function distributeKeyToMember(
  channelId: string,
  userId: string,
  memberEdPub: Uint8Array,
): Promise<void> {
  let version = getLatestKeyVersion(channelId);

  // Cache miss — attempt server fetch before giving up
  if (version === null) {
    try {
      await fetchAndCacheChannelKeys(channelId);
    } catch (err) {
      console.warn(
        `[E2EE] distributeKeyToMember fetch failed for ${channelId}:`,
        err,
      );
      return;
    }
    version = getLatestKeyVersion(channelId);
    if (version === null) return;
  }

  const key = channelKeyCache.get(channelId)?.get(version);
  if (!key) return;
  const aad = buildKeyWrapAAD(channelId, memberEdPub);
  const envelope = await wrapChannelKey(key, memberEdPub, aad);
  await storeKeyEnvelopes(channelId, version, [{ userId, envelope }]);
}

/**
 * Lazily initialize a channel key for a channel that has none.
 * Fetch-first: tries to retrieve existing keys from the server before
 * creating a new one with RotateChannelKey(expectedVersion=0).
 * After creation, distributes to all members with ViewChannel.
 *
 * @param channelId - Channel to create a key for
 * @param userId - Current user's ID (for the self-envelope)
 * @returns true if key is now available (created or fetched)
 */
export function lazyInitChannelKey(
  channelId: string,
  userId: string,
): Promise<boolean> {
  const existing = lazyInitInFlight.get(channelId);
  if (existing) return existing;

  const promise = doLazyInit(channelId, userId).finally(() => {
    lazyInitInFlight.delete(channelId);
  });
  lazyInitInFlight.set(channelId, promise);
  return promise;
}

async function doLazyInit(channelId: string, userId: string): Promise<boolean> {
  if (!identityKeypair) return false;

  // Fetch-first: try to get existing keys from the server
  try {
    await fetchAndCacheChannelKeys(channelId);
    if (hasChannelKey(channelId)) return true;
  } catch (err) {
    console.warn(
      `[E2EE] lazyInit fetch failed for ${channelId}, will attempt creation:`,
      err,
    );
  }

  // No keys exist — create version 1 atomically
  const newKey = generateChannelKey();
  const selfAad = buildKeyWrapAAD(channelId, identityKeypair.publicKey);
  const selfEnvelope = await wrapChannelKey(
    newKey,
    identityKeypair.publicKey,
    selfAad,
  );

  try {
    const newVersion = await rotateChannelKeyRpc(channelId, 0, [
      { userId, envelope: selfEnvelope },
    ]);
    setCachedKey(channelId, newVersion, newKey);
    schedulePersist();

    // Distribute to remaining members in background (non-blocking)
    distributeKeyToAllMembers(channelId, newKey, newVersion).catch((err) =>
      console.error(
        `[E2EE] lazy init distribution failed for ${channelId}:`,
        err,
      ),
    );
    return true;
  } catch (err) {
    // Version conflict — another client created the key first, re-fetch
    console.warn(
      `[E2EE] lazyInit creation conflict for ${channelId}, re-fetching:`,
      err,
    );
    try {
      await fetchAndCacheChannelKeys(channelId);
      return hasChannelKey(channelId);
    } catch (fetchErr) {
      console.error(
        `[E2EE] lazyInit re-fetch failed for ${channelId}:`,
        fetchErr,
      );
      return false;
    }
  }
}

/**
 * Distribute a known key+version to all members with ViewChannel.
 * Streams page-by-page to avoid accumulating the full member list in memory.
 * Used by both provisionChannelKeyBatched and doLazyInit.
 */
async function distributeKeyToAllMembers(
  channelId: string,
  key: Uint8Array,
  version: number,
): Promise<void> {
  let cursor = '';
  do {
    const page = await listMembersWithViewChannel(channelId, cursor);
    const memberPubKeys = new Map<string, Uint8Array>();
    for (const m of page.members) {
      if (m.signingPublicKey.length > 0) {
        memberPubKeys.set(m.userId, m.signingPublicKey);
      }
    }
    if (memberPubKeys.size > 0) {
      const envelopes = await wrapKeyForMembers(channelId, key, memberPubKeys);
      await storeKeyEnvelopes(channelId, version, envelopes);
    }
    cursor = page.nextCursor;
    if (cursor) await new Promise((r) => setTimeout(r, 0));
  } while (cursor);
}

/**
 * Re-distribute existing cached keys to all members with ViewChannel.
 * Called after permission changes (role updates, override changes) that
 * may have granted ViewChannel to new users. UPSERT semantics make
 * duplicate distributions safe.
 *
 * @param channelIds - Channels to redistribute keys for
 */
export async function redistributeChannelKeys(
  channelIds: string[],
): Promise<void> {
  for (const channelId of channelIds) {
    const version = getLatestKeyVersion(channelId);
    if (version === null) continue;
    const key = channelKeyCache.get(channelId)?.get(version);
    if (!key) continue;
    try {
      await distributeKeyToAllMembers(channelId, key, version);
    } catch (err) {
      console.error(
        `[E2EE] redistributeChannelKeys failed for ${channelId}:`,
        err,
      );
    }
  }
}

/**
 * Provision a channel key for all members with ViewChannel permission.
 * Creates a new version-1 key and streams it to members page-by-page
 * to avoid accumulating the full member list in memory.
 *
 * @param channelId - Channel to provision
 */
export async function provisionChannelKeyBatched(
  channelId: string,
): Promise<void> {
  if (!identityKeypair) return;

  const { key, version } = createChannelKey(channelId);
  await distributeKeyToAllMembers(channelId, key, version);
}

/**
 * Rotate the channel key: generate a new version, wrap for remaining members,
 * and upload atomically via RotateChannelKey RPC.
 *
 * Uses optimistic concurrency — retries once on version conflict by
 * re-fetching the latest version from the server.
 */
export async function rotateChannelKey(
  channelId: string,
  remainingMembers: Map<string, Uint8Array>,
  currentVersion: number,
): Promise<number> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const newKey = generateChannelKey();
    const envelopes = await wrapKeyForMembers(
      channelId,
      newKey,
      remainingMembers,
    );

    try {
      const newVersion = await rotateChannelKeyRpc(
        channelId,
        currentVersion,
        envelopes,
      );

      setCachedKey(channelId, newVersion, newKey);
      schedulePersist();
      return newVersion;
    } catch (err) {
      if (attempt === 0) {
        // Version conflict — re-fetch keys and retry with updated version
        await fetchAndCacheChannelKeys(channelId);
        const latestVersion = getLatestKeyVersion(channelId);
        if (latestVersion && latestVersion > currentVersion) {
          currentVersion = latestVersion;
          continue;
        }
      }
      throw err;
    }
  }
  throw new Error(`Key rotation failed after retries for ${channelId}`);
}

/**
 * Get all cached channel IDs (for session bootstrap prefetch).
 */
export function getCachedChannelIds(): string[] {
  return [...channelKeyCache.keys()];
}

/**
 * Get cached channel keys for a set of channel IDs.
 * Returns a map of channelId → (version → base64-encoded key).
 * Used by invite key bundles to pre-share keys with joining members.
 */
export function getChannelKeysForServer(
  channelIds: string[],
): Record<string, Record<string, string>> {
  const result: Record<string, Record<string, string>> = {};
  for (const channelId of channelIds) {
    const versionMap = channelKeyCache.get(channelId);
    if (!versionMap || versionMap.size === 0) continue;
    const versions: Record<string, string> = {};
    for (const [version, key] of versionMap) {
      versions[String(version)] = bytesToBase64(key);
    }
    result[channelId] = versions;
  }
  return result;
}

/**
 * Import channel keys from an external source (e.g., invite key bundle).
 * Sets keys in cache and triggers persist to IndexedDB.
 */
export function importChannelKeys(
  keys: Record<string, Record<string, string>>,
): void {
  for (const [channelId, versions] of Object.entries(keys)) {
    for (const [version, keyB64] of Object.entries(versions)) {
      setCachedKey(channelId, Number(version), base64ToBytes(keyB64));
    }
  }
  schedulePersist();
}

// Flush pending persist when tab becomes hidden or page unloads to prevent data loss.
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      flushChannelKeys();
    }
  });
}
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    flushChannelKeys();
  });
}
