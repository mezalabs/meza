/**
 * Cryptographic primitives for static channel key E2EE.
 *
 * Uses @noble/curves for Ed25519/X25519 and Web Crypto API for AES-256-GCM.
 * Implements the ECIES pattern for channel key wrapping:
 *   ephemeral X25519 DH + HKDF-SHA256 + AES-256-GCM
 *
 * Prior art: Keybase PTK model (EUROCRYPT 2024), Virgil E3Kit.
 */

import { ed25519, x25519 } from '@noble/curves/ed25519.js';

// --- Identity keypair (Ed25519) ---

export interface IdentityKeypair {
  /** Ed25519 secret key (32 bytes) */
  secretKey: Uint8Array;
  /** Ed25519 public/verify key (32 bytes) */
  publicKey: Uint8Array;
}

/**
 * Generate a new Ed25519 identity keypair.
 * The keypair is used for message signing and (via X25519 derivation) key wrapping.
 */
export function generateIdentityKeypair(): IdentityKeypair {
  return ed25519.keygen();
}

/**
 * Serialize an identity keypair to bytes for encrypted storage.
 * Format: [32B secretKey][32B publicKey] = 64 bytes
 */
export function serializeIdentity(keypair: IdentityKeypair): Uint8Array {
  const bytes = new Uint8Array(64);
  bytes.set(keypair.secretKey, 0);
  bytes.set(keypair.publicKey, 32);
  return bytes;
}

/**
 * Deserialize an identity keypair from bytes.
 */
export function deserializeIdentity(bytes: Uint8Array): IdentityKeypair {
  if (bytes.length !== 64) {
    throw new Error(`Invalid identity bytes: expected 64, got ${bytes.length}`);
  }
  return {
    secretKey: bytes.slice(0, 32),
    publicKey: bytes.slice(32, 64),
  };
}

// --- Ed25519 signing ---

/**
 * Sign a message with an Ed25519 secret key.
 * Returns a 64-byte signature.
 */
export function signMessage(
  secretKey: Uint8Array,
  content: Uint8Array,
): Uint8Array {
  return ed25519.sign(content, secretKey);
}

/**
 * Verify an Ed25519 signature.
 * Uses strict RFC 8032 / FIPS 186-5 mode (zip215: false) for non-repudiation.
 */
export function verifySignature(
  publicKey: Uint8Array,
  signature: Uint8Array,
  content: Uint8Array,
): boolean {
  try {
    return ed25519.verify(signature, content, publicKey, { zip215: false });
  } catch {
    return false;
  }
}

// --- X25519 key derivation ---

/**
 * Derive an X25519 public key from an Ed25519 public key.
 * This is a one-way conversion (Edwards → Montgomery curve).
 */
export function edToX25519Public(edPub: Uint8Array): Uint8Array {
  return ed25519.utils.toMontgomery(edPub);
}

/**
 * Derive an X25519 secret key from an Ed25519 secret key.
 */
export function edToX25519Secret(edSecret: Uint8Array): Uint8Array {
  return ed25519.utils.toMontgomerySecret(edSecret);
}

// --- Channel key generation ---

/**
 * Generate a random 256-bit channel key for AES-256-GCM message encryption.
 */
export function generateChannelKey(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

// --- ECIES key wrapping ---

const KEY_WRAP_INFO = new TextEncoder().encode('meza-key-wrap-v1');

/**
 * Wrap a channel key for a recipient using ECIES.
 *
 * 1. Generate ephemeral X25519 keypair
 * 2. DH with recipient's X25519 public key (derived from their Ed25519 pub)
 * 3. HKDF-SHA256(shared, salt=ephemeral_pub||recipient_pub, info="meza-key-wrap-v1")
 * 4. AES-256-GCM encrypt the channel key
 *
 * Returns a 92-byte envelope: [ephemeral_pub(32) || nonce(12) || wrapped(48)]
 * (48 = 32 bytes channel key + 16 bytes GCM auth tag)
 */
export async function wrapChannelKey(
  channelKey: Uint8Array,
  recipientEdPub: Uint8Array,
): Promise<Uint8Array> {
  // Convert recipient Ed25519 pub to X25519
  const recipientX25519Pub = edToX25519Public(recipientEdPub);

  // Ephemeral X25519 keypair for this wrapping operation
  const ephemeral = x25519.keygen();

  // DH shared secret
  const shared = x25519.getSharedSecret(
    ephemeral.secretKey,
    recipientX25519Pub,
  );

  // HKDF salt = ephemeral_pub || recipient_x25519_pub
  const salt = new Uint8Array(64);
  salt.set(ephemeral.publicKey, 0);
  salt.set(recipientX25519Pub, 32);

  // Derive wrapping key via HKDF-SHA256
  const hkdfKey = await crypto.subtle.importKey(
    'raw',
    shared as BufferSource,
    'HKDF',
    false,
    ['deriveKey'],
  );
  const wrappingKey = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: KEY_WRAP_INFO },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt'],
  );

  // Encrypt channel key with AES-256-GCM
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const wrapped = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce },
    wrappingKey,
    channelKey as BufferSource,
  );

  // Pack envelope: [ephemeral_pub(32) || nonce(12) || wrapped(48)]
  const envelope = new Uint8Array(32 + 12 + wrapped.byteLength);
  envelope.set(ephemeral.publicKey, 0);
  envelope.set(nonce, 32);
  envelope.set(new Uint8Array(wrapped), 44);

  return envelope;
}

/**
 * Unwrap a channel key from an ECIES envelope using the recipient's Ed25519 secret key.
 */
export async function unwrapChannelKey(
  envelope: Uint8Array,
  edSecretKey: Uint8Array,
): Promise<Uint8Array> {
  if (envelope.length !== 92) {
    throw new Error(
      `Invalid envelope size: expected 92, got ${envelope.length}`,
    );
  }

  // Parse envelope
  const ephemeralPub = envelope.slice(0, 32);
  const nonce = envelope.slice(32, 44);
  const wrapped = envelope.slice(44);

  // Convert own Ed25519 secret to X25519
  const myX25519Secret = edToX25519Secret(edSecretKey);
  const myX25519Pub = x25519.getPublicKey(myX25519Secret);

  // DH shared secret
  const shared = x25519.getSharedSecret(myX25519Secret, ephemeralPub);

  // HKDF salt = ephemeral_pub || recipient_x25519_pub (same as in wrap)
  const salt = new Uint8Array(64);
  salt.set(ephemeralPub, 0);
  salt.set(myX25519Pub, 32);

  // Derive wrapping key via HKDF-SHA256
  const hkdfKey = await crypto.subtle.importKey(
    'raw',
    shared as BufferSource,
    'HKDF',
    false,
    ['deriveKey'],
  );
  const wrappingKey = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: KEY_WRAP_INFO },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt'],
  );

  // Decrypt channel key
  const channelKey = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: nonce },
    wrappingKey,
    wrapped as BufferSource,
  );

  return new Uint8Array(channelKey);
}

// --- AES-GCM CryptoKey cache ---

/**
 * Cache imported CryptoKey objects to avoid calling crypto.subtle.importKey
 * on every encrypt/decrypt. Keyed by hex(channelKey) + usage.
 *
 * WebCrypto importKey is async and non-trivial — caching turns batch decrypts
 * of 50+ messages from O(n) importKey calls to a single import per channel key.
 */
const aesKeyCache = new Map<string, CryptoKey>();

function channelKeyCacheKey(
  rawKey: Uint8Array,
  usage: 'encrypt' | 'decrypt',
): string {
  // Fast hex from first 8 bytes (enough for uniqueness) + usage suffix
  let hex = '';
  const len = Math.min(rawKey.length, 8);
  for (let i = 0; i < len; i++) {
    hex += rawKey[i].toString(16).padStart(2, '0');
  }
  return `${hex}:${usage}`;
}

async function getAesKey(
  rawKey: Uint8Array,
  usage: 'encrypt' | 'decrypt',
): Promise<CryptoKey> {
  const cacheKey = channelKeyCacheKey(rawKey, usage);
  const cached = aesKeyCache.get(cacheKey);
  if (cached) return cached;

  const imported = await crypto.subtle.importKey(
    'raw',
    rawKey as BufferSource,
    'AES-GCM',
    false,
    [usage],
  );
  aesKeyCache.set(cacheKey, imported);
  return imported;
}

/** Clear the AES key cache (call on session teardown). */
export function clearAesKeyCache(): void {
  aesKeyCache.clear();
}

// --- Message payload encryption ---

/**
 * Encrypt a payload with AES-256-GCM using a channel key.
 * Returns nonce(12) || ciphertext (includes 16-byte GCM auth tag).
 */
export async function encryptPayload(
  channelKey: Uint8Array,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const aesKey = await getAesKey(channelKey, 'encrypt');
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce },
    aesKey,
    plaintext as BufferSource,
  );

  // Pack: [nonce(12) || ciphertext]
  const result = new Uint8Array(12 + ciphertext.byteLength);
  result.set(nonce, 0);
  result.set(new Uint8Array(ciphertext), 12);
  return result;
}

/**
 * Decrypt a payload with AES-256-GCM using a channel key.
 * Input format: nonce(12) || ciphertext (with GCM auth tag).
 */
export async function decryptPayload(
  channelKey: Uint8Array,
  noncePlusCiphertext: Uint8Array,
): Promise<Uint8Array> {
  if (noncePlusCiphertext.length < 28) {
    throw new Error('Ciphertext too short');
  }

  const nonce = noncePlusCiphertext.slice(0, 12);
  const ciphertext = noncePlusCiphertext.slice(12);

  const aesKey = await getAesKey(channelKey, 'decrypt');
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: nonce },
    aesKey,
    ciphertext as BufferSource,
  );

  return new Uint8Array(plaintext);
}
