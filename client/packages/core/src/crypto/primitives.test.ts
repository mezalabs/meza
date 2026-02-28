import { describe, expect, it } from 'vitest';
import {
  decryptPayload,
  deserializeIdentity,
  edToX25519Public,
  edToX25519Secret,
  encryptPayload,
  generateChannelKey,
  generateIdentityKeypair,
  serializeIdentity,
  signMessage,
  unwrapChannelKey,
  verifySignature,
  wrapChannelKey,
} from './primitives.ts';

describe('generateIdentityKeypair', () => {
  it('generates an Ed25519 keypair with correct key sizes', () => {
    const kp = generateIdentityKeypair();
    expect(kp.secretKey).toBeInstanceOf(Uint8Array);
    expect(kp.publicKey).toBeInstanceOf(Uint8Array);
    expect(kp.secretKey.length).toBe(32);
    expect(kp.publicKey.length).toBe(32);
  });

  it('generates different keypairs each time', () => {
    const kp1 = generateIdentityKeypair();
    const kp2 = generateIdentityKeypair();
    expect(kp1.secretKey).not.toEqual(kp2.secretKey);
    expect(kp1.publicKey).not.toEqual(kp2.publicKey);
  });
});

describe('serializeIdentity / deserializeIdentity', () => {
  it('roundtrips an identity keypair', () => {
    const kp = generateIdentityKeypair();
    const bytes = serializeIdentity(kp);
    expect(bytes.length).toBe(64);

    const restored = deserializeIdentity(bytes);
    expect(restored.secretKey).toEqual(kp.secretKey);
    expect(restored.publicKey).toEqual(kp.publicKey);
  });

  it('rejects invalid byte lengths', () => {
    expect(() => deserializeIdentity(new Uint8Array(32))).toThrow(
      'Invalid identity bytes',
    );
    expect(() => deserializeIdentity(new Uint8Array(0))).toThrow(
      'Invalid identity bytes',
    );
  });
});

describe('signMessage / verifySignature', () => {
  it('signs and verifies a message', () => {
    const kp = generateIdentityKeypair();
    const msg = new TextEncoder().encode('hello meza');
    const sig = signMessage(kp.secretKey, msg);

    expect(sig).toBeInstanceOf(Uint8Array);
    expect(sig.length).toBe(64);
    expect(verifySignature(kp.publicKey, sig, msg)).toBe(true);
  });

  it('rejects a signature with wrong public key', () => {
    const kp1 = generateIdentityKeypair();
    const kp2 = generateIdentityKeypair();
    const msg = new TextEncoder().encode('hello');
    const sig = signMessage(kp1.secretKey, msg);

    expect(verifySignature(kp2.publicKey, sig, msg)).toBe(false);
  });

  it('rejects a signature with tampered content', () => {
    const kp = generateIdentityKeypair();
    const msg = new TextEncoder().encode('hello');
    const sig = signMessage(kp.secretKey, msg);

    const tampered = new TextEncoder().encode('world');
    expect(verifySignature(kp.publicKey, sig, tampered)).toBe(false);
  });

  it('rejects a tampered signature', () => {
    const kp = generateIdentityKeypair();
    const msg = new TextEncoder().encode('hello');
    const sig = signMessage(kp.secretKey, msg);

    const badSig = new Uint8Array(sig);
    badSig[0] ^= 0xff;
    expect(verifySignature(kp.publicKey, badSig, msg)).toBe(false);
  });

  it('signs and verifies empty content', () => {
    const kp = generateIdentityKeypair();
    const empty = new Uint8Array(0);
    const sig = signMessage(kp.secretKey, empty);
    expect(verifySignature(kp.publicKey, sig, empty)).toBe(true);
  });
});

describe('edToX25519Public / edToX25519Secret', () => {
  it('derives X25519 keys from Ed25519 keys', () => {
    const kp = generateIdentityKeypair();
    const x25519Pub = edToX25519Public(kp.publicKey);
    const x25519Sec = edToX25519Secret(kp.secretKey);

    expect(x25519Pub).toBeInstanceOf(Uint8Array);
    expect(x25519Sec).toBeInstanceOf(Uint8Array);
    expect(x25519Pub.length).toBe(32);
    expect(x25519Sec.length).toBe(32);
  });

  it('derives consistent X25519 public key from Ed25519 public key', () => {
    const kp = generateIdentityKeypair();
    const x1 = edToX25519Public(kp.publicKey);
    const x2 = edToX25519Public(kp.publicKey);
    expect(x1).toEqual(x2);
  });
});

describe('generateChannelKey', () => {
  it('generates a 32-byte random key', () => {
    const key = generateChannelKey();
    expect(key).toBeInstanceOf(Uint8Array);
    expect(key.length).toBe(32);
  });

  it('generates different keys each time', () => {
    const k1 = generateChannelKey();
    const k2 = generateChannelKey();
    expect(k1).not.toEqual(k2);
  });
});

describe('wrapChannelKey / unwrapChannelKey', () => {
  it('roundtrips a channel key through ECIES wrapping', async () => {
    const recipient = generateIdentityKeypair();
    const channelKey = generateChannelKey();

    const envelope = await wrapChannelKey(channelKey, recipient.publicKey);
    expect(envelope).toBeInstanceOf(Uint8Array);
    expect(envelope.length).toBe(92);

    const unwrapped = await unwrapChannelKey(envelope, recipient.secretKey);
    expect(unwrapped).toEqual(channelKey);
  });

  it('produces different envelopes for the same key (ephemeral keypair)', async () => {
    const recipient = generateIdentityKeypair();
    const channelKey = generateChannelKey();

    const env1 = await wrapChannelKey(channelKey, recipient.publicKey);
    const env2 = await wrapChannelKey(channelKey, recipient.publicKey);
    expect(env1).not.toEqual(env2);

    // Both unwrap to the same key
    const k1 = await unwrapChannelKey(env1, recipient.secretKey);
    const k2 = await unwrapChannelKey(env2, recipient.secretKey);
    expect(k1).toEqual(channelKey);
    expect(k2).toEqual(channelKey);
  });

  it('fails with wrong recipient secret key', async () => {
    const recipient = generateIdentityKeypair();
    const wrongRecipient = generateIdentityKeypair();
    const channelKey = generateChannelKey();

    const envelope = await wrapChannelKey(channelKey, recipient.publicKey);
    await expect(
      unwrapChannelKey(envelope, wrongRecipient.secretKey),
    ).rejects.toThrow();
  });

  it('fails with tampered envelope', async () => {
    const recipient = generateIdentityKeypair();
    const channelKey = generateChannelKey();

    const envelope = await wrapChannelKey(channelKey, recipient.publicKey);
    // Tamper with the wrapped key portion
    envelope[80] ^= 0xff;

    await expect(
      unwrapChannelKey(envelope, recipient.secretKey),
    ).rejects.toThrow();
  });

  it('rejects invalid envelope size', async () => {
    const recipient = generateIdentityKeypair();
    await expect(
      unwrapChannelKey(new Uint8Array(50), recipient.secretKey),
    ).rejects.toThrow('Invalid envelope size');
  });

  it('wraps for multiple recipients independently', async () => {
    const alice = generateIdentityKeypair();
    const bob = generateIdentityKeypair();
    const channelKey = generateChannelKey();

    const envAlice = await wrapChannelKey(channelKey, alice.publicKey);
    const envBob = await wrapChannelKey(channelKey, bob.publicKey);

    // Each can unwrap their own envelope
    const aliceKey = await unwrapChannelKey(envAlice, alice.secretKey);
    const bobKey = await unwrapChannelKey(envBob, bob.secretKey);
    expect(aliceKey).toEqual(channelKey);
    expect(bobKey).toEqual(channelKey);

    // Cross-unwrapping fails
    await expect(unwrapChannelKey(envAlice, bob.secretKey)).rejects.toThrow();
    await expect(unwrapChannelKey(envBob, alice.secretKey)).rejects.toThrow();
  });
});

describe('encryptPayload / decryptPayload', () => {
  it('roundtrips plaintext through encryption', async () => {
    const key = generateChannelKey();
    const plaintext = new TextEncoder().encode('hello meza e2ee');

    const encrypted = await encryptPayload(key, plaintext);
    // 12 bytes nonce + plaintext.length + 16 bytes GCM auth tag
    expect(encrypted.length).toBe(12 + plaintext.length + 16);

    const decrypted = await decryptPayload(key, encrypted);
    expect(decrypted).toEqual(plaintext);
  });

  it('produces different ciphertext each time (random nonce)', async () => {
    const key = generateChannelKey();
    const plaintext = new TextEncoder().encode('same data');

    const enc1 = await encryptPayload(key, plaintext);
    const enc2 = await encryptPayload(key, plaintext);
    expect(enc1).not.toEqual(enc2);

    // Both decrypt to the same plaintext
    expect(await decryptPayload(key, enc1)).toEqual(plaintext);
    expect(await decryptPayload(key, enc2)).toEqual(plaintext);
  });

  it('fails decryption with wrong key', async () => {
    const key1 = generateChannelKey();
    const key2 = generateChannelKey();
    const plaintext = new TextEncoder().encode('secret');

    const encrypted = await encryptPayload(key1, plaintext);
    await expect(decryptPayload(key2, encrypted)).rejects.toThrow();
  });

  it('fails decryption with tampered ciphertext', async () => {
    const key = generateChannelKey();
    const plaintext = new TextEncoder().encode('secret');

    const encrypted = await encryptPayload(key, plaintext);
    encrypted[20] ^= 0xff;

    await expect(decryptPayload(key, encrypted)).rejects.toThrow();
  });

  it('handles empty plaintext', async () => {
    const key = generateChannelKey();
    const empty = new Uint8Array(0);

    const encrypted = await encryptPayload(key, empty);
    expect(encrypted.length).toBe(12 + 16); // nonce + auth tag only

    const decrypted = await decryptPayload(key, encrypted);
    expect(decrypted.length).toBe(0);
  });

  it('rejects too-short ciphertext', async () => {
    const key = generateChannelKey();
    await expect(decryptPayload(key, new Uint8Array(12))).rejects.toThrow(
      'Ciphertext too short',
    );
  });
});

describe('full sign-then-encrypt flow', () => {
  it('signs content, encrypts signature+content, decrypts, and verifies', async () => {
    const sender = generateIdentityKeypair();
    const channelKey = generateChannelKey();
    const content = new TextEncoder().encode('Hello from Alice!');

    // Sign
    const signature = signMessage(sender.secretKey, content);

    // Pack: [signature(64) || content]
    const payload = new Uint8Array(64 + content.length);
    payload.set(signature, 0);
    payload.set(content, 64);

    // Encrypt
    const encrypted = await encryptPayload(channelKey, payload);

    // Decrypt
    const decrypted = await decryptPayload(channelKey, encrypted);

    // Unpack
    const decSig = decrypted.slice(0, 64);
    const decContent = decrypted.slice(64);

    // Verify
    expect(verifySignature(sender.publicKey, decSig, decContent)).toBe(true);
    expect(new TextDecoder().decode(decContent)).toBe('Hello from Alice!');
  });
});

describe('nonce uniqueness', () => {
  it('produces unique nonces across 1000 encryptions', async () => {
    const key = generateChannelKey();
    const plaintext = new TextEncoder().encode('test');
    const nonces = new Set<string>();

    for (let i = 0; i < 1000; i++) {
      const encrypted = await encryptPayload(key, plaintext);
      // First 12 bytes are the nonce
      const nonce = Buffer.from(encrypted.slice(0, 12)).toString('hex');
      nonces.add(nonce);
    }

    expect(nonces.size).toBe(1000);
  });
});

describe('cross-channel key isolation', () => {
  it('key from channel A cannot decrypt channel B message', async () => {
    const keyA = generateChannelKey();
    const keyB = generateChannelKey();
    const plaintext = new TextEncoder().encode('secret');

    const encrypted = await encryptPayload(keyA, plaintext);
    await expect(decryptPayload(keyB, encrypted)).rejects.toThrow();
  });
});

describe('ephemeral key uniqueness', () => {
  it('produces unique ephemeral keys across 50 ECIES wrappings', async () => {
    const channelKey = generateChannelKey();
    const identity = generateIdentityKeypair();
    const ephemeralKeys = new Set<string>();

    for (let i = 0; i < 50; i++) {
      const envelope = await wrapChannelKey(channelKey, identity.publicKey);
      // First 32 bytes are the ephemeral public key
      const ephPub = Buffer.from(envelope.slice(0, 32)).toString('hex');
      ephemeralKeys.add(ephPub);
    }

    expect(ephemeralKeys.size).toBe(50);
  });
});

describe('tampered nonce detection', () => {
  it('rejects ciphertext with flipped nonce bit', async () => {
    const key = generateChannelKey();
    const plaintext = new TextEncoder().encode('test');
    const encrypted = await encryptPayload(key, plaintext);

    // Flip a bit in the nonce (first 12 bytes)
    const tampered = new Uint8Array(encrypted);
    tampered[0] ^= 0x01;

    await expect(decryptPayload(key, tampered)).rejects.toThrow();
  });
});

describe('minimum ciphertext length', () => {
  it('rejects payload shorter than nonce + GCM tag (28 bytes)', async () => {
    const key = generateChannelKey();
    // 27 bytes: too short (need at least 12 nonce + 16 tag = 28)
    const tooShort = new Uint8Array(27);
    await expect(decryptPayload(key, tooShort)).rejects.toThrow();
  });

  it('accepts payload of exactly 28 bytes (nonce + empty plaintext)', async () => {
    const key = generateChannelKey();
    // Encrypt empty plaintext -> should produce nonce(12) + GCM(empty_ct + 16_tag)
    const encrypted = await encryptPayload(key, new Uint8Array(0));
    // Should be 12 + 16 = 28 bytes minimum
    expect(encrypted.length).toBeGreaterThanOrEqual(28);
    // Should roundtrip
    const decrypted = await decryptPayload(key, encrypted);
    expect(decrypted.byteLength).toBe(0);
  });
});
