/**
 * Invite key bundle: encrypt/decrypt channel keys for offline key distribution.
 *
 * A random 32-byte inviteSecret is appended to the invite URL as a fragment.
 * An AES-256-GCM key is derived from it via HKDF-SHA256. The server stores
 * only the opaque ciphertext — it cannot read the channel keys.
 */

import { getChannelKeysForServer, importChannelKeys } from './channel-keys.ts';
import { aesGcmDecrypt, aesGcmEncrypt } from './keys.ts';

const HKDF_INFO = new TextEncoder().encode('meza-invite-keys-v1');
const HKDF_SALT = new Uint8Array(32); // Zero-salt — input is already high-entropy (random 32 bytes)

/**
 * Derive an AES-256-GCM key from the invite secret using HKDF-SHA256.
 */
async function deriveInviteKey(inviteSecret: Uint8Array): Promise<Uint8Array> {
  const hkdfKey = await crypto.subtle.importKey(
    'raw',
    inviteSecret as BufferSource,
    'HKDF',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: HKDF_SALT, info: HKDF_INFO },
    hkdfKey,
    256,
  );
  return new Uint8Array(bits);
}

/**
 * Create an encrypted key bundle containing all cached channel keys
 * for the given channel IDs.
 *
 * @param inviteSecret - 32-byte random secret (will be in URL fragment)
 * @param channelIds - Channel IDs to include in the bundle
 * @returns Encrypted bundle (ciphertext + IV) ready to store on the server
 */
export async function createInviteKeyBundle(
  inviteSecret: Uint8Array,
  channelIds: string[],
): Promise<{ ciphertext: Uint8Array; iv: Uint8Array }> {
  const keys = getChannelKeysForServer(channelIds);
  const plaintext = new TextEncoder().encode(JSON.stringify(keys));
  const aesKey = await deriveInviteKey(inviteSecret);
  return aesGcmEncrypt(aesKey, plaintext);
}

/**
 * Decrypt an invite key bundle and import the channel keys into the local cache.
 *
 * @param inviteSecret - 32-byte secret from the invite URL fragment
 * @param ciphertext - Encrypted key bundle from the server
 * @param iv - 12-byte IV for AES-GCM decryption
 */
export async function importInviteKeyBundle(
  inviteSecret: Uint8Array,
  ciphertext: Uint8Array,
  iv: Uint8Array,
): Promise<void> {
  const aesKey = await deriveInviteKey(inviteSecret);
  const plaintext = await aesGcmDecrypt(aesKey, ciphertext, iv);
  const json = new TextDecoder().decode(plaintext);
  const keys = JSON.parse(json) as Record<string, Record<string, string>>;
  importChannelKeys(keys);
}
