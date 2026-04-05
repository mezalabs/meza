/**
 * Safety number derivation for out-of-band key verification.
 *
 * Implements Signal's NumericFingerprintGenerator algorithm adapted for Meza:
 * iterated SHA-512 over Ed25519 public keys + user IDs, encoded as 60 decimal
 * digits displayed in a 4×3 grid of 5-digit groups.
 *
 * Reference: github.com/signalapp/libsignal-protocol-java
 *   NumericFingerprintGenerator.java
 */

import { sha512 } from '@noble/hashes/sha2.js';
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';

/** Protocol version bytes — allows safe algorithm upgrades in the future. */
const FINGERPRINT_VERSION = new Uint8Array([0x00, 0x00]);

/**
 * Number of SHA-512 iterations per fingerprint.
 * Signal uses 5200; provides >112 bits of pre-image resistance.
 */
const HASH_ITERATIONS = 5200;

/**
 * Compute a 30-digit numeric fingerprint for a single user's identity key.
 *
 * Algorithm (per Signal spec):
 *   Iteration 0: SHA-512(version || publicKey || userId || publicKey)
 *   Iterations 1..5199: SHA-512(previousHash || publicKey)
 *   Encode first 30 bytes as 6 groups of 5 decimal digits (mod 100000).
 */
export function computeFingerprint(
  publicKey: Uint8Array,
  userId: string,
): string {
  if (publicKey.length !== 32) {
    throw new Error('Public key must be 32 bytes (Ed25519)');
  }
  if (!userId) {
    throw new Error('User ID is required');
  }

  const userIdBytes = utf8ToBytes(userId);

  // Iteration 0: include version, key, identifier, and key again
  let hash = sha512(
    concatBytes(FINGERPRINT_VERSION, publicKey, userIdBytes, publicKey),
  );

  // Iterations 1..5199: hash previous output with the public key
  for (let i = 1; i < HASH_ITERATIONS; i++) {
    hash = sha512(concatBytes(hash, publicKey));
  }

  // Numeric encoding: first 30 bytes → 6 groups of 5 digits
  let digits = '';
  for (let offset = 0; offset < 30; offset += 5) {
    // Read 5 bytes as big-endian uint40 (max 2^40 - 1, safe for JS Number)
    const chunk =
      hash[offset] * 2 ** 32 +
      hash[offset + 1] * 2 ** 24 +
      hash[offset + 2] * 2 ** 16 +
      hash[offset + 3] * 2 ** 8 +
      hash[offset + 4];
    digits += String(chunk % 100000).padStart(5, '0');
  }

  return digits;
}

/**
 * Compute a 60-digit safety number for a pair of users.
 *
 * The result is deterministic and symmetric: both users see the same number
 * regardless of who is "local" vs "remote" (sorted lexicographically).
 */
export function computeSafetyNumber(
  myKey: Uint8Array,
  myId: string,
  theirKey: Uint8Array,
  theirId: string,
): string {
  const myFingerprint = computeFingerprint(myKey, myId);
  const theirFingerprint = computeFingerprint(theirKey, theirId);

  return myFingerprint <= theirFingerprint
    ? myFingerprint + theirFingerprint
    : theirFingerprint + myFingerprint;
}

/**
 * Format a 60-digit safety number as a 4×3 grid of 5-digit groups.
 *
 * Returns a 4-element array of 3-element string arrays, matching Signal's
 * display layout:
 *
 *   30035 44776 92869
 *   39689 28698 76765
 *   45825 75691 62576
 *   84344 09180 79131
 */
export function formatSafetyNumber(safetyNumber: string): string[][] {
  if (safetyNumber.length !== 60) {
    throw new Error('Safety number must be 60 digits');
  }

  const grid: string[][] = [];
  for (let row = 0; row < 4; row++) {
    const rowGroups: string[] = [];
    for (let col = 0; col < 3; col++) {
      const idx = (row * 3 + col) * 5;
      rowGroups.push(safetyNumber.slice(idx, idx + 5));
    }
    grid.push(rowGroups);
  }
  return grid;
}
