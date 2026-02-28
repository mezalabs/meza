/**
 * Key derivation and symmetric encryption helpers for E2EE.
 *
 * Password → Argon2id(64 bytes) → HKDF-SHA256 → master_key (32B) + auth_key (32B)
 *
 * - auth_key: sent to server to prove identity (replaces raw password)
 * - master_key: encrypts the local identity keypair (never leaves the client)
 */

const HKDF_INFO_MASTER = new TextEncoder().encode('meza-master-key');
const HKDF_INFO_AUTH = new TextEncoder().encode('meza-auth-key');
const HKDF_SALT = new Uint8Array(32); // Zero-salt is fine when input is already high-entropy (Argon2id output)

export interface DerivedKeys {
  masterKey: Uint8Array;
  authKey: Uint8Array;
}

/**
 * Derive master_key and auth_key from a password + salt using Argon2id → HKDF-SHA256.
 *
 * Argon2id produces 64 bytes of high-entropy output. HKDF extracts two
 * independent 32-byte keys from that material using different info strings.
 */
export async function deriveKeys(
  password: string,
  salt: Uint8Array,
): Promise<DerivedKeys> {
  const { argon2id } = await import('hash-wasm');

  // Argon2id → 64 bytes (hex output, we convert to bytes)
  const argonHex = await argon2id({
    password,
    salt,
    parallelism: 4,
    iterations: 2,
    memorySize: 65536,
    hashLength: 64,
    outputType: 'hex',
  });
  const argonOutput = hexToBytes(argonHex);

  // Import Argon2id output as HKDF key material
  const hkdfKey = await crypto.subtle.importKey(
    'raw',
    argonOutput as BufferSource,
    'HKDF',
    false,
    ['deriveBits'],
  );

  // Derive master_key (32 bytes) for encrypting the key bundle
  const masterBits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: HKDF_SALT, info: HKDF_INFO_MASTER },
    hkdfKey,
    256,
  );

  // Derive auth_key (32 bytes) for server authentication
  const authBits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: HKDF_SALT, info: HKDF_INFO_AUTH },
    hkdfKey,
    256,
  );

  return {
    masterKey: new Uint8Array(masterBits),
    authKey: new Uint8Array(authBits),
  };
}

/**
 * Encrypt data with AES-256-GCM.
 * Returns { ciphertext, iv } where iv is a random 12-byte nonce.
 */
export async function aesGcmEncrypt(
  key: Uint8Array,
  plaintext: Uint8Array,
): Promise<{ ciphertext: Uint8Array; iv: Uint8Array }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aesKey = await crypto.subtle.importKey(
    'raw',
    key as BufferSource,
    'AES-GCM',
    false,
    ['encrypt'],
  );
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    aesKey,
    plaintext as BufferSource,
  );
  return { ciphertext: new Uint8Array(ciphertext), iv };
}

/**
 * Decrypt data with AES-256-GCM.
 */
export async function aesGcmDecrypt(
  key: Uint8Array,
  ciphertext: Uint8Array,
  iv: Uint8Array,
): Promise<Uint8Array> {
  const aesKey = await crypto.subtle.importKey(
    'raw',
    key as BufferSource,
    'AES-GCM',
    false,
    ['decrypt'],
  );
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    aesKey,
    ciphertext as BufferSource,
  );
  return new Uint8Array(plaintext);
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new Error('Invalid hex string in key derivation');
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
