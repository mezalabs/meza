/**
 * Cross-platform crypto test suite.
 *
 * These tests use DETERMINISTIC test vectors (fixed keys, salts, IVs) so
 * results can be compared byte-for-byte across Web Crypto API (Node/browser)
 * and react-native-quick-crypto (React Native).
 *
 * Run in Vitest (Node.js): validates Web Crypto baseline.
 * Run in RN dev client: validates quick-crypto parity (future).
 */

import { describe, expect, it } from 'vitest';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import {
  edToX25519Public,
  edToX25519Secret,
  generateIdentityKeypair,
  signMessage,
  verifySignature,
} from './primitives.ts';
import { deriveKeys } from './keys.ts';

// ── Helpers ──

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// ── Fixed test vectors ──

const FIXED_KEY_32 = hexToBytes(
  'deadbeefcafebabe0123456789abcdef0011223344556677889900aabbccddeeff'.slice(
    0,
    64,
  ),
);
const FIXED_IV_12 = hexToBytes('aabbccddeeff00112233aabb');
const FIXED_PLAINTEXT = new TextEncoder().encode(
  'Hello, Meza E2EE cross-platform!',
);
const FIXED_SALT_16 = new Uint8Array([
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
]);

// ── AES-256-GCM deterministic tests ──

describe('cross-platform: AES-256-GCM', () => {
  it('encrypt with fixed key + IV produces deterministic ciphertext', async () => {
    const aesKey = await crypto.subtle.importKey(
      'raw',
      FIXED_KEY_32 as BufferSource,
      'AES-GCM',
      false,
      ['encrypt'],
    );
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: FIXED_IV_12 as BufferSource },
      aesKey,
      FIXED_PLAINTEXT as BufferSource,
    );

    const hex = bytesToHex(new Uint8Array(ciphertext));

    // Record the expected output — same on every platform
    // If this changes on a different crypto backend, parity is broken
    expect(hex).toMatchInlineSnapshot(
      `"9c49b7585669406662dd1fd6f0891710026cc20652ca0e399e4b4dca01db131273bb0921f0f84e1bb3e7ae7e9583212c"`,
    );
  });

  it('decrypt with fixed key + IV recovers original plaintext', async () => {
    // First encrypt to get the ciphertext
    const aesKey = await crypto.subtle.importKey(
      'raw',
      FIXED_KEY_32 as BufferSource,
      'AES-GCM',
      false,
      ['encrypt', 'decrypt'],
    );
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: FIXED_IV_12 as BufferSource },
      aesKey,
      FIXED_PLAINTEXT as BufferSource,
    );

    // Then decrypt
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: FIXED_IV_12 as BufferSource },
      aesKey,
      ciphertext as BufferSource,
    );

    expect(new Uint8Array(plaintext)).toEqual(FIXED_PLAINTEXT);
  });

  it('wrong key fails to decrypt', async () => {
    const aesKey = await crypto.subtle.importKey(
      'raw',
      FIXED_KEY_32 as BufferSource,
      'AES-GCM',
      false,
      ['encrypt'],
    );
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: FIXED_IV_12 as BufferSource },
      aesKey,
      FIXED_PLAINTEXT as BufferSource,
    );

    const wrongKey = new Uint8Array(32).fill(0xff);
    const decKey = await crypto.subtle.importKey(
      'raw',
      wrongKey as BufferSource,
      'AES-GCM',
      false,
      ['decrypt'],
    );

    await expect(
      crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: FIXED_IV_12 as BufferSource },
        decKey,
        ciphertext as BufferSource,
      ),
    ).rejects.toThrow();
  });
});

// ── HKDF-SHA256 deterministic tests ──

describe('cross-platform: HKDF-SHA256', () => {
  it('derives deterministic 32-byte key from fixed input', async () => {
    const ikm = FIXED_KEY_32;
    const salt = FIXED_SALT_16;
    const info = new TextEncoder().encode('meza-test-info');

    const hkdfKey = await crypto.subtle.importKey(
      'raw',
      ikm as BufferSource,
      'HKDF',
      false,
      ['deriveBits'],
    );
    const derived = await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt, info },
      hkdfKey,
      256,
    );

    const hex = bytesToHex(new Uint8Array(derived));
    expect(hex).toMatchInlineSnapshot(
      `"aedb7287ec3ebb41fe5d9c59197be8cdabad8f139ca802df0a651eeb5c1afcb1"`,
    );
  });

  it('different info strings produce different keys', async () => {
    const ikm = FIXED_KEY_32;
    const salt = FIXED_SALT_16;

    const hkdfKey = await crypto.subtle.importKey(
      'raw',
      ikm as BufferSource,
      'HKDF',
      false,
      ['deriveBits'],
    );

    const key1 = new Uint8Array(
      await crypto.subtle.deriveBits(
        {
          name: 'HKDF',
          hash: 'SHA-256',
          salt,
          info: new TextEncoder().encode('meza-master-key'),
        },
        hkdfKey,
        256,
      ),
    );

    const key2 = new Uint8Array(
      await crypto.subtle.deriveBits(
        {
          name: 'HKDF',
          hash: 'SHA-256',
          salt,
          info: new TextEncoder().encode('meza-auth-key'),
        },
        hkdfKey,
        256,
      ),
    );

    expect(key1).not.toEqual(key2);

    // Record expected values
    expect(bytesToHex(key1)).toMatchInlineSnapshot(
      `"e5d297c36ea42632c05c6ef4af39efeb1692fb5c51ca5be04d81a3d3647f5061"`,
    );
    expect(bytesToHex(key2)).toMatchInlineSnapshot(
      `"9f415c03815050d6438998a10ab7b5ef1566bc558c113a919a0c5605b5635e8f"`,
    );
  });
});

// ── Ed25519 sign/verify (via @noble/curves — inherently cross-platform) ──

describe('cross-platform: Ed25519 sign/verify', () => {
  // Fixed Ed25519 seed for deterministic testing
  const FIXED_ED_SEED = hexToBytes(
    '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60',
  );

  it('produces deterministic signature from fixed seed', () => {
    const publicKey = ed25519.getPublicKey(FIXED_ED_SEED);
    const message = new TextEncoder().encode('test message');
    const sig = ed25519.sign(message, FIXED_ED_SEED);

    // Verify the signature
    expect(ed25519.verify(sig, message, publicKey)).toBe(true);

    // Record expected values
    expect(bytesToHex(publicKey)).toMatchInlineSnapshot(
      `"d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a"`,
    );
    expect(bytesToHex(sig)).toMatchInlineSnapshot(
      `"98a39ec11a0dfbbfdbd7a7e2394b2b83a16586e92100bcb9be672ddfba3e7acb861c94d6ad4cf6e3e60136ca141fc4f2f1be0c1b8ef0bea12aee76f007a4c30a"`,
    );
  });

  it('sign/verify roundtrip with generateIdentityKeypair', () => {
    const kp = generateIdentityKeypair();
    const msg = new TextEncoder().encode('cross-platform test');
    const sig = signMessage(kp.secretKey, msg);
    expect(verifySignature(kp.publicKey, sig, msg)).toBe(true);
  });
});

// ── X25519 ECDH key agreement ──

describe('cross-platform: X25519 ECDH', () => {
  it('DH shared secret is deterministic from fixed keys', () => {
    // Two fixed X25519 secret keys
    const aliceSecret = hexToBytes(
      '77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a',
    );
    const bobSecret = hexToBytes(
      '5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb',
    );

    const alicePub = x25519.getPublicKey(aliceSecret);
    const bobPub = x25519.getPublicKey(bobSecret);

    // Alice computes shared secret with Bob's pub
    const sharedA = x25519.getSharedSecret(aliceSecret, bobPub);
    // Bob computes shared secret with Alice's pub
    const sharedB = x25519.getSharedSecret(bobSecret, alicePub);

    // Both must produce the same shared secret
    expect(bytesToHex(sharedA)).toEqual(bytesToHex(sharedB));

    // Record the expected shared secret (RFC 7748 test vector)
    expect(bytesToHex(sharedA)).toMatchInlineSnapshot(
      `"4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742"`,
    );
  });

  it('Ed25519 to X25519 conversion is deterministic', () => {
    const kp = generateIdentityKeypair();
    const x1 = edToX25519Public(kp.publicKey);
    const x2 = edToX25519Public(kp.publicKey);
    expect(x1).toEqual(x2);

    const xs1 = edToX25519Secret(kp.secretKey);
    const xs2 = edToX25519Secret(kp.secretKey);
    expect(xs1).toEqual(xs2);
  });
});

// ── ECIES wrap/unwrap round-trip ──

describe('cross-platform: ECIES wrap/unwrap', () => {
  it('wraps and unwraps channel key correctly', async () => {
    const {
      wrapChannelKey,
      unwrapChannelKey,
      generateChannelKey,
    } = await import('./primitives.ts');

    const recipient = generateIdentityKeypair();
    const channelKey = generateChannelKey();

    const envelope = await wrapChannelKey(channelKey, recipient.publicKey);
    expect(envelope.length).toBe(92);

    const unwrapped = await unwrapChannelKey(envelope, recipient.secretKey);
    expect(unwrapped).toEqual(channelKey);
  });
});

// ── Argon2id → HKDF full pipeline ──

describe('cross-platform: Argon2id → HKDF key derivation pipeline', () => {
  it('deriveKeys produces deterministic masterKey + authKey from fixed inputs', async () => {
    const password = 'test-password-deterministic';
    const salt = FIXED_SALT_16;

    const keys1 = await deriveKeys(password, salt);
    const keys2 = await deriveKeys(password, salt);

    // Same password + salt → same keys
    expect(keys1.masterKey).toEqual(keys2.masterKey);
    expect(keys1.authKey).toEqual(keys2.authKey);

    // Keys are 32 bytes each
    expect(keys1.masterKey.length).toBe(32);
    expect(keys1.authKey.length).toBe(32);

    // Master and auth keys are different
    expect(keys1.masterKey).not.toEqual(keys1.authKey);

    // Record expected values for cross-platform comparison
    expect(bytesToHex(keys1.masterKey)).toMatchInlineSnapshot(
      `"7037e2dbc5b0f0ac4d03fe6f6133d5379b7cf65ced428471e608b91bbb51f29a"`,
    );
    expect(bytesToHex(keys1.authKey)).toMatchInlineSnapshot(
      `"7d101e096b89401eba8f151f17a2525a3e51f5eac3654dfaaf08cad112263f6f"`,
    );
  });
});

// ── Full E2EE message round-trip ──

describe('cross-platform: full E2EE message flow', () => {
  it('sign → encrypt → decrypt → verify', async () => {
    const {
      encryptPayload,
      decryptPayload,
      generateChannelKey,
    } = await import('./primitives.ts');

    const sender = generateIdentityKeypair();
    const channelKey = generateChannelKey();
    const content = new TextEncoder().encode('Cross-platform E2EE works!');

    // Sign
    const signature = signMessage(sender.secretKey, content);
    expect(signature.length).toBe(64);

    // Pack: [signature(64) || content]
    const payload = new Uint8Array(64 + content.length);
    payload.set(signature, 0);
    payload.set(content, 64);

    // Encrypt
    const encrypted = await encryptPayload(channelKey, payload);
    expect(encrypted.length).toBe(12 + 64 + content.length + 16);

    // Decrypt
    const decrypted = await decryptPayload(channelKey, encrypted);

    // Unpack
    const decSig = decrypted.slice(0, 64);
    const decContent = decrypted.slice(64);

    // Verify
    expect(verifySignature(sender.publicKey, decSig, decContent)).toBe(true);
    expect(new TextDecoder().decode(decContent)).toBe(
      'Cross-platform E2EE works!',
    );
  });
});
