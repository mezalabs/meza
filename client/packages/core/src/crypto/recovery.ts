/**
 * BIP39-based recovery phrase for identity keypair backup.
 *
 * Flow:
 *  1. Generate 12-word mnemonic (128-bit entropy)
 *  2. Derive 256-bit recovery key: PBKDF2(mnemonic, salt="meza-recovery", 600_000 iterations)
 *  3. Encrypt identity keypair with AES-256-GCM using recovery key
 *  4. Store encrypted recovery bundle on server alongside the password-encrypted bundle
 *
 * Recovery:
 *  1. User enters 12-word phrase + new password
 *  2. Derive recovery key from phrase
 *  3. Fetch recovery bundle from server
 *  4. Decrypt identity bytes with recovery key
 *  5. Re-encrypt with new password-derived master key
 *  6. Upload new bundles to server
 */

import { aesGcmDecrypt, aesGcmEncrypt } from './keys.ts';

const PBKDF2_ITERATIONS = 600_000;
const PBKDF2_SALT = new TextEncoder().encode('meza-recovery');

/**
 * Generate a new 12-word BIP39 mnemonic recovery phrase.
 */
export async function generateRecoveryPhrase(): Promise<string> {
  const { generateMnemonic } = await import('@scure/bip39');
  const { wordlist } = await import('@scure/bip39/wordlists/english.js');
  return generateMnemonic(wordlist, 128);
}

/**
 * Validate that a string is a valid 12-word BIP39 mnemonic.
 */
export async function validateRecoveryPhrase(phrase: string): Promise<boolean> {
  const { validateMnemonic } = await import('@scure/bip39');
  const { wordlist } = await import('@scure/bip39/wordlists/english.js');
  return validateMnemonic(phrase.trim().toLowerCase(), wordlist);
}

/**
 * Derive a 256-bit recovery key from a BIP39 mnemonic using PBKDF2-SHA256.
 */
export async function deriveRecoveryKey(phrase: string): Promise<Uint8Array> {
  const normalized = phrase.trim().toLowerCase();
  const encoded = new TextEncoder().encode(normalized);

  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoded,
    'PBKDF2',
    false,
    ['deriveBits'],
  );

  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: PBKDF2_SALT,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    256,
  );

  return new Uint8Array(bits);
}

/**
 * Derive a 32-byte recovery verifier from a recovery key using HKDF-SHA256.
 * The server stores SHA-256(verifier) and checks it during account recovery
 * to prove the caller actually knows the recovery phrase.
 *
 * Domain-separated from the recovery key itself so the server cannot
 * use the verifier to decrypt the recovery bundle.
 */
export async function deriveRecoveryVerifier(
  recoveryKey: Uint8Array,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', recoveryKey, 'HKDF', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(32), // empty salt — domain separation is in info
      info: new TextEncoder().encode('meza-recovery-verifier'),
    },
    key,
    256,
  );
  return new Uint8Array(bits);
}

/**
 * Encrypt the identity keypair with a recovery key for server-side backup.
 * Returns { ciphertext, iv } for storage as recovery_encrypted_key_bundle + recovery_key_bundle_iv.
 */
export async function encryptRecoveryBundle(
  recoveryKey: Uint8Array,
  keyBundle: Uint8Array,
): Promise<{ ciphertext: Uint8Array; iv: Uint8Array }> {
  return aesGcmEncrypt(recoveryKey, keyBundle);
}

/**
 * Decrypt the recovery bundle using the recovery key derived from a BIP39 phrase.
 */
export async function decryptRecoveryBundle(
  recoveryKey: Uint8Array,
  ciphertext: Uint8Array,
  iv: Uint8Array,
): Promise<Uint8Array> {
  return aesGcmDecrypt(recoveryKey, ciphertext, iv);
}
