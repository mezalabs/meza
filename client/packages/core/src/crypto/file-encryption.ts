/**
 * File encryption for E2EE attachments.
 *
 * Each file gets a random AES-256-GCM key. The file and its thumbnail
 * are encrypted with this key. The per-file key is wrapped (encrypted)
 * with the channel key and stored server-side as `encrypted_key`.
 *
 * File body uses per-file key (no AAD — the unique key provides binding).
 * File key wrapping uses channel key with AAD to prevent cross-channel swaps.
 */

import { buildContextAAD, PURPOSE_FILE_KEY } from './aad.ts';
import { getChannelKey, getLatestKeyVersion } from './channel-keys.ts';
import { aesGcmDecrypt, aesGcmEncrypt } from './keys.ts';
import { decryptPayload, encryptPayload } from './primitives.ts';

/**
 * Generate a random 32-byte AES-256-GCM key for encrypting a single file.
 */
export function generateFileKey(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

/**
 * Encrypt file bytes with a per-file key.
 * Returns nonce(12) || ciphertext + auth_tag(16).
 *
 * No AAD: the per-file key is unique to this file, so the key itself
 * provides context binding. AAD is used when wrapping this key with
 * the channel key (see wrapFileKey).
 */
export async function encryptFile(
  fileKey: Uint8Array,
  fileBytes: Uint8Array,
): Promise<Uint8Array> {
  const { ciphertext, iv } = await aesGcmEncrypt(fileKey, fileBytes);
  // Pack: [nonce(12) || ciphertext]
  const result = new Uint8Array(iv.length + ciphertext.length);
  result.set(iv, 0);
  result.set(ciphertext, iv.length);
  return result;
}

/**
 * Decrypt file bytes with a per-file key.
 * Input format: nonce(12) || ciphertext + auth_tag(16).
 */
export async function decryptFile(
  fileKey: Uint8Array,
  data: Uint8Array,
): Promise<Uint8Array> {
  if (data.length < 28) {
    throw new Error('Encrypted file data too short');
  }
  const iv = data.slice(0, 12);
  const ciphertext = data.slice(12);
  return aesGcmDecrypt(fileKey, ciphertext, iv);
}

/**
 * Wrap a per-file key with the channel key for server storage.
 *
 * The output format is: keyVersion(4 bytes BE) || wrappedKey(60 bytes)
 * = 64 bytes total. This self-describes which channel key version was
 * used, so unwrapFileKey doesn't need an external keyVersion parameter.
 *
 * AAD binds the wrapped key to the channel and key version,
 * preventing cross-channel file key substitution.
 */
export async function wrapFileKey(
  channelId: string,
  fileKey: Uint8Array,
): Promise<Uint8Array> {
  const keyVersion = getLatestKeyVersion(channelId);
  if (keyVersion === null) {
    throw new Error(`No channel key available for ${channelId}`);
  }
  const channelKey = await getChannelKey(channelId, keyVersion);
  const aad = buildContextAAD(PURPOSE_FILE_KEY, channelId, keyVersion);
  const wrappedKey = await encryptPayload(channelKey, fileKey, aad);

  // Prepend key version as 4-byte big-endian
  const result = new Uint8Array(4 + wrappedKey.length);
  new DataView(result.buffer).setUint32(0, keyVersion);
  result.set(wrappedKey, 4);
  return result;
}

/**
 * Unwrap a per-file key from server-stored encrypted_key bytes.
 *
 * Input format: keyVersion(4 bytes BE) || wrappedKey(60 bytes).
 * Returns the original 32-byte file key.
 */
export async function unwrapFileKey(
  channelId: string,
  encryptedKey: Uint8Array,
): Promise<Uint8Array> {
  if (encryptedKey.length < 5) {
    throw new Error('Invalid encrypted key: too short');
  }
  // Use .slice() to create an owned copy — avoids Safari/iOS issues
  // with DataView and crypto.subtle on Uint8Array views with non-zero
  // byteOffset (common when protobuf-es returns pooled buffer views).
  const ownedKey = encryptedKey.slice();
  const keyVersion = new DataView(ownedKey.buffer).getUint32(0);
  const wrappedKey = ownedKey.slice(4);
  const channelKey = await getChannelKey(channelId, keyVersion);
  const aad = buildContextAAD(PURPOSE_FILE_KEY, channelId, keyVersion);
  return decryptPayload(channelKey, wrappedKey, aad);
}
