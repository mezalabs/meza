/**
 * Key change detection and verification status management.
 *
 * Tracks users' public keys in IndexedDB and detects when a key changes
 * (indicating potential server-side key substitution). Manages verification
 * status for safety numbers.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import {
  deleteVerification,
  loadCachedKey,
  loadVerification,
  storeCachedKey,
  storeVerification,
  type VerificationRecord,
} from './storage.ts';

export type KeyCacheResult = 'first-seen' | 'unchanged' | 'changed';

/** Callback invoked when a key change is detected. Set by the UI layer. */
let onKeyChangedCallback: ((userId: string) => void) | null = null;

/**
 * Register a callback for key change events. Called from the UI layer
 * to bridge core → UI notifications without a direct import.
 */
export function onKeyChanged(
  callback: ((userId: string) => void) | null,
): void {
  onKeyChangedCallback = callback;
}

/**
 * Compare a fetched public key against the IndexedDB cache for a user.
 *
 * Returns:
 * - 'first-seen': No cached key existed; the key is now cached.
 * - 'unchanged': The cached key matches the fetched key.
 * - 'changed': The cached key differs from the fetched key (updated in cache).
 */
export async function cachePublicKey(
  userId: string,
  publicKey: Uint8Array,
): Promise<KeyCacheResult> {
  const cached = await loadCachedKey(userId);

  if (!cached) {
    await storeCachedKey({
      userId,
      publicKey,
      firstSeenAt: Date.now(),
    });
    return 'first-seen';
  }

  if (keysEqual(cached.publicKey, publicKey)) {
    return 'unchanged';
  }

  // Key changed — update cache with new key
  await storeCachedKey({
    userId,
    publicKey,
    firstSeenAt: cached.firstSeenAt,
  });
  onKeyChangedCallback?.(userId);
  return 'changed';
}

/**
 * Get the verification status for a user from IndexedDB.
 */
export async function getVerificationStatus(
  userId: string,
): Promise<VerificationRecord | null> {
  return loadVerification(userId);
}

/**
 * Mark a user as verified. Stores a SHA-256 hash of their current public key
 * so verification can be invalidated if the key changes.
 */
export async function markVerified(
  userId: string,
  publicKey: Uint8Array,
): Promise<void> {
  await storeVerification({
    userId,
    verified: true,
    publicKeyHash: hashPublicKey(publicKey),
    verifiedAt: Date.now(),
  });
}

/**
 * Clear verification status for a user (e.g., on key change).
 */
export async function clearVerification(userId: string): Promise<void> {
  await deleteVerification(userId);
}

/**
 * Check whether a user's verification is still valid against their current key.
 * Returns false if no verification exists or if the stored key hash doesn't
 * match the current key.
 */
export async function isVerificationValid(
  userId: string,
  currentKey: Uint8Array,
): Promise<boolean> {
  const record = await loadVerification(userId);
  if (!record?.verified) return false;
  return record.publicKeyHash === hashPublicKey(currentKey);
}

/** SHA-256 hex digest of a public key, used to bind verification to key material. */
function hashPublicKey(publicKey: Uint8Array): string {
  return bytesToHex(sha256(publicKey));
}

/** Constant-time-ish comparison of two Uint8Arrays. */
function keysEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}
