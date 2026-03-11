import { describe, expect, it } from 'vitest';
import {
  deriveVerificationCode,
  generateRecoveryKeypair,
  unwrapIdentityFromRecovery,
  wrapIdentityForRecovery,
} from './device-recovery.ts';
import { generateIdentityKeypair } from './primitives.ts';

describe('generateRecoveryKeypair', () => {
  it('generates an X25519 keypair with 32-byte keys', () => {
    const kp = generateRecoveryKeypair();
    expect(kp.publicKey).toBeInstanceOf(Uint8Array);
    expect(kp.secretKey).toBeInstanceOf(Uint8Array);
    expect(kp.publicKey.length).toBe(32);
    expect(kp.secretKey.length).toBe(32);
  });

  it('generates different keypairs each time', () => {
    const kp1 = generateRecoveryKeypair();
    const kp2 = generateRecoveryKeypair();
    expect(kp1.publicKey).not.toEqual(kp2.publicKey);
    expect(kp1.secretKey).not.toEqual(kp2.secretKey);
  });
});

describe('deriveVerificationCode', () => {
  it('produces the same code for the same input', async () => {
    const kp = generateRecoveryKeypair();
    const code1 = await deriveVerificationCode(kp.publicKey);
    const code2 = await deriveVerificationCode(kp.publicKey);
    expect(code1).toBe(code2);
  });

  it('matches the "XXX XXX" format', async () => {
    const kp = generateRecoveryKeypair();
    const code = await deriveVerificationCode(kp.publicKey);
    expect(code).toMatch(/^\d{3} \d{3}$/);
  });

  it('produces different codes for different keys', async () => {
    const kp1 = generateRecoveryKeypair();
    const kp2 = generateRecoveryKeypair();
    const code1 = await deriveVerificationCode(kp1.publicKey);
    const code2 = await deriveVerificationCode(kp2.publicKey);
    // Extremely unlikely to collide with random keys
    expect(code1).not.toBe(code2);
  });
});

describe('wrapIdentityForRecovery / unwrapIdentityFromRecovery', () => {
  it('round-trips: recovered identity matches original', async () => {
    const identity = generateIdentityKeypair();
    const recipient = generateRecoveryKeypair();

    const envelope = await wrapIdentityForRecovery(
      identity,
      recipient.publicKey,
    );
    expect(envelope).toBeInstanceOf(Uint8Array);
    expect(envelope.length).toBe(124);

    const recovered = await unwrapIdentityFromRecovery(
      envelope,
      recipient.secretKey,
    );
    expect(recovered.secretKey).toEqual(identity.secretKey);
    expect(recovered.publicKey).toEqual(identity.publicKey);
  });

  it('produces different envelopes for the same identity (ephemeral keypair)', async () => {
    const identity = generateIdentityKeypair();
    const recipient = generateRecoveryKeypair();

    const env1 = await wrapIdentityForRecovery(identity, recipient.publicKey);
    const env2 = await wrapIdentityForRecovery(identity, recipient.publicKey);
    expect(env1).not.toEqual(env2);

    // Both unwrap to the same identity
    const r1 = await unwrapIdentityFromRecovery(env1, recipient.secretKey);
    const r2 = await unwrapIdentityFromRecovery(env2, recipient.secretKey);
    expect(r1.secretKey).toEqual(identity.secretKey);
    expect(r1.publicKey).toEqual(identity.publicKey);
    expect(r2.secretKey).toEqual(identity.secretKey);
    expect(r2.publicKey).toEqual(identity.publicKey);
  });

  it('fails with wrong recipient secret key', async () => {
    const identity = generateIdentityKeypair();
    const recipient = generateRecoveryKeypair();
    const wrongRecipient = generateRecoveryKeypair();

    const envelope = await wrapIdentityForRecovery(
      identity,
      recipient.publicKey,
    );
    await expect(
      unwrapIdentityFromRecovery(envelope, wrongRecipient.secretKey),
    ).rejects.toThrow();
  });
});

describe('low-order point rejection', () => {
  /** Build a 32-byte key from a hex string. */
  function hexToBytes(hex: string): Uint8Array {
    const bytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
      bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
  }

  const lowOrderPoints = [
    '0000000000000000000000000000000000000000000000000000000000000000',
    '0100000000000000000000000000000000000000000000000000000000000000',
    'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
    'e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800',
    '5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157',
  ];

  it('wrapIdentityForRecovery throws for all-zero public key', async () => {
    const identity = generateIdentityKeypair();
    const allZero = hexToBytes(lowOrderPoints[0]);

    await expect(wrapIdentityForRecovery(identity, allZero)).rejects.toThrow(
      'low-order point',
    );
  });

  it('wrapIdentityForRecovery throws for 0x01...00 public key', async () => {
    const identity = generateIdentityKeypair();
    const onePoint = hexToBytes(lowOrderPoints[1]);

    await expect(wrapIdentityForRecovery(identity, onePoint)).rejects.toThrow(
      'low-order point',
    );
  });

  it.each(
    lowOrderPoints,
  )('wrapIdentityForRecovery throws for low-order point %s', async (hex) => {
    const identity = generateIdentityKeypair();
    const badPub = hexToBytes(hex);

    await expect(wrapIdentityForRecovery(identity, badPub)).rejects.toThrow(
      'low-order point',
    );
  });

  it('unwrapIdentityFromRecovery throws when envelope contains low-order sender ephemeral pub', async () => {
    // Craft a fake 124-byte envelope with a low-order point as the sender ephemeral pub
    const allZero = hexToBytes(lowOrderPoints[0]);
    const fakeEnvelope = new Uint8Array(124);
    fakeEnvelope.set(allZero, 0); // sender ephemeral pub = all zeros

    const recipientSecret = generateRecoveryKeypair().secretKey;

    await expect(
      unwrapIdentityFromRecovery(fakeEnvelope, recipientSecret),
    ).rejects.toThrow('low-order point');
  });

  it('unwrapIdentityFromRecovery throws for each low-order sender pub', async () => {
    const recipientSecret = generateRecoveryKeypair().secretKey;

    for (const hex of lowOrderPoints) {
      const badPub = hexToBytes(hex);
      const fakeEnvelope = new Uint8Array(124);
      fakeEnvelope.set(badPub, 0);

      await expect(
        unwrapIdentityFromRecovery(fakeEnvelope, recipientSecret),
      ).rejects.toThrow('low-order point');
    }
  });
});

describe('invalid envelope size', () => {
  it('throws on too-short envelope', async () => {
    const recipientSecret = generateRecoveryKeypair().secretKey;

    await expect(
      unwrapIdentityFromRecovery(new Uint8Array(100), recipientSecret),
    ).rejects.toThrow('Invalid recovery envelope size');
  });

  it('throws on too-long envelope', async () => {
    const recipientSecret = generateRecoveryKeypair().secretKey;

    await expect(
      unwrapIdentityFromRecovery(new Uint8Array(200), recipientSecret),
    ).rejects.toThrow('Invalid recovery envelope size');
  });

  it('throws on empty envelope', async () => {
    const recipientSecret = generateRecoveryKeypair().secretKey;

    await expect(
      unwrapIdentityFromRecovery(new Uint8Array(0), recipientSecret),
    ).rejects.toThrow('Invalid recovery envelope size');
  });

  it('includes expected and actual size in error message', async () => {
    const recipientSecret = generateRecoveryKeypair().secretKey;

    await expect(
      unwrapIdentityFromRecovery(new Uint8Array(50), recipientSecret),
    ).rejects.toThrow('expected 124, got 50');
  });
});

describe('tampered ciphertext', () => {
  it('throws on tampered ciphertext bytes', async () => {
    const identity = generateIdentityKeypair();
    const recipient = generateRecoveryKeypair();

    const envelope = await wrapIdentityForRecovery(
      identity,
      recipient.publicKey,
    );

    // Tamper with the ciphertext portion (after byte 44 = 32 pub + 12 nonce)
    const tampered = new Uint8Array(envelope);
    tampered[80] ^= 0xff;

    await expect(
      unwrapIdentityFromRecovery(tampered, recipient.secretKey),
    ).rejects.toThrow();
  });

  it('throws on tampered nonce bytes', async () => {
    const identity = generateIdentityKeypair();
    const recipient = generateRecoveryKeypair();

    const envelope = await wrapIdentityForRecovery(
      identity,
      recipient.publicKey,
    );

    // Tamper with the nonce (bytes 32-43)
    const tampered = new Uint8Array(envelope);
    tampered[35] ^= 0x01;

    await expect(
      unwrapIdentityFromRecovery(tampered, recipient.secretKey),
    ).rejects.toThrow();
  });

  it('throws on tampered sender ephemeral pub (non-low-order)', async () => {
    const identity = generateIdentityKeypair();
    const recipient = generateRecoveryKeypair();

    const envelope = await wrapIdentityForRecovery(
      identity,
      recipient.publicKey,
    );

    // Tamper with the sender ephemeral pub (first 32 bytes)
    // Flip a bit in a middle byte to avoid accidentally hitting a low-order point
    const tampered = new Uint8Array(envelope);
    tampered[16] ^= 0x01;

    await expect(
      unwrapIdentityFromRecovery(tampered, recipient.secretKey),
    ).rejects.toThrow();
  });
});

describe('envelope structure', () => {
  it('envelope is exactly 124 bytes: 32 pub + 12 nonce + 80 ciphertext', async () => {
    const identity = generateIdentityKeypair();
    const recipient = generateRecoveryKeypair();

    const envelope = await wrapIdentityForRecovery(
      identity,
      recipient.publicKey,
    );

    expect(envelope.length).toBe(124);
    // 80 = 64 bytes identity + 16 bytes GCM auth tag
  });

  it('sender ephemeral pub in envelope differs from recipient pub', async () => {
    const identity = generateIdentityKeypair();
    const recipient = generateRecoveryKeypair();

    const envelope = await wrapIdentityForRecovery(
      identity,
      recipient.publicKey,
    );

    const senderEphemeralPub = envelope.slice(0, 32);
    expect(senderEphemeralPub).not.toEqual(recipient.publicKey);
  });

  it('ephemeral sender pub is unique per wrapping', async () => {
    const identity = generateIdentityKeypair();
    const recipient = generateRecoveryKeypair();

    const env1 = await wrapIdentityForRecovery(identity, recipient.publicKey);
    const env2 = await wrapIdentityForRecovery(identity, recipient.publicKey);

    const senderPub1 = env1.slice(0, 32);
    const senderPub2 = env2.slice(0, 32);
    expect(senderPub1).not.toEqual(senderPub2);
  });
});
