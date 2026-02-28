/**
 * E2EE credential (Identity) management.
 *
 * Creates, persists, and restores the user's Ed25519 identity keypair.
 * The keypair is used for message signing and (via X25519 derivation) key wrapping.
 *
 * Persistence flow:
 *   generateIdentityKeypair() → serializeIdentity() → encrypt(masterKey) → IndexedDB
 *   IndexedDB → decrypt(masterKey) → deserializeIdentity() → IdentityKeypair
 */

import { registerPublicKey as registerPublicKeyRpc } from '../api/keys.ts';
import { aesGcmDecrypt, aesGcmEncrypt } from './keys.ts';
import {
  deserializeIdentity,
  generateIdentityKeypair,
  type IdentityKeypair,
  serializeIdentity,
} from './primitives.ts';
import { loadKeyBundle, storeKeyBundle } from './storage.ts';

/**
 * Create a new Ed25519 identity keypair.
 */
export function createIdentity(): IdentityKeypair {
  return generateIdentityKeypair();
}

/**
 * Persist an identity keypair to IndexedDB, encrypted with the user's master key.
 * The serialized bytes contain the Ed25519 private key — never store unencrypted.
 */
export async function persistIdentity(
  keypair: IdentityKeypair,
  masterKey: Uint8Array,
): Promise<void> {
  const identityBytes = serializeIdentity(keypair);
  const { ciphertext, iv } = await aesGcmEncrypt(masterKey, identityBytes);

  // Pack ciphertext + iv together: [12 bytes iv][ciphertext...]
  const packed = new Uint8Array(12 + ciphertext.length);
  packed.set(iv, 0);
  packed.set(ciphertext, 12);

  await storeKeyBundle(packed);
}

/**
 * Restore an identity keypair from IndexedDB using the user's master key.
 * Returns null if no identity is stored.
 */
export async function restoreIdentity(
  masterKey: Uint8Array,
): Promise<IdentityKeypair | null> {
  const packed = await loadKeyBundle();
  if (!packed) return null;

  const iv = packed.slice(0, 12);
  const ciphertext = packed.slice(12);
  const plaintext = await aesGcmDecrypt(masterKey, ciphertext, iv);

  return deserializeIdentity(plaintext);
}

/**
 * Upload the Ed25519 signing public key to the server.
 * Called at registration and login so other members can verify signatures
 * and wrap channel keys for this user.
 */
export async function registerPublicKey(
  publicKey: Uint8Array,
): Promise<void> {
  await registerPublicKeyRpc(publicKey);
}
