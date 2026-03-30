import { describe, expect, it } from 'vitest';
import { aesGcmDecrypt, aesGcmEncrypt, deriveKeys } from './keys.ts';

describe('deriveKeys', () => {
  it('derives two different 32-byte keys from the same password', async () => {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const { masterKey, authKey } = await deriveKeys('test-password-123', salt);

    expect(masterKey).toBeInstanceOf(Uint8Array);
    expect(authKey).toBeInstanceOf(Uint8Array);
    expect(masterKey.length).toBe(32);
    expect(authKey.length).toBe(32);

    // Master and auth keys must be different
    expect(masterKey).not.toEqual(authKey);
  });

  it(
    'produces deterministic output for the same password + salt',
    { timeout: 15_000 },
    async () => {
      const salt = new Uint8Array([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
      ]);
      const keys1 = await deriveKeys('hello', salt);
      const keys2 = await deriveKeys('hello', salt);

      expect(keys1.masterKey).toEqual(keys2.masterKey);
      expect(keys1.authKey).toEqual(keys2.authKey);
    },
  );

  it('produces different output for different passwords', async () => {
    const salt = new Uint8Array([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
    ]);
    const keys1 = await deriveKeys('password-a', salt);
    const keys2 = await deriveKeys('password-b', salt);

    expect(keys1.masterKey).not.toEqual(keys2.masterKey);
    expect(keys1.authKey).not.toEqual(keys2.authKey);
  });

  it('produces different output for different salts', async () => {
    const salt1 = new Uint8Array(16).fill(1);
    const salt2 = new Uint8Array(16).fill(2);
    const keys1 = await deriveKeys('same-password', salt1);
    const keys2 = await deriveKeys('same-password', salt2);

    expect(keys1.masterKey).not.toEqual(keys2.masterKey);
    expect(keys1.authKey).not.toEqual(keys2.authKey);
  });
});

describe('aesGcmEncrypt / aesGcmDecrypt', () => {
  it('roundtrips plaintext through encrypt then decrypt', async () => {
    const masterKey = crypto.getRandomValues(new Uint8Array(32));
    const plaintext = new TextEncoder().encode('my secret key bundle data');

    const { ciphertext, iv } = await aesGcmEncrypt(masterKey, plaintext);
    const decrypted = await aesGcmDecrypt(masterKey, ciphertext, iv);

    expect(decrypted).toEqual(plaintext);
  });

  it('produces different ciphertext on each encryption (random IV)', async () => {
    const masterKey = crypto.getRandomValues(new Uint8Array(32));
    const plaintext = new TextEncoder().encode('same data');

    const enc1 = await aesGcmEncrypt(masterKey, plaintext);
    const enc2 = await aesGcmEncrypt(masterKey, plaintext);

    // IVs should differ
    expect(enc1.iv).not.toEqual(enc2.iv);
    // Ciphertext should differ
    expect(enc1.ciphertext).not.toEqual(enc2.ciphertext);

    // But both decrypt to the same plaintext
    const dec1 = await aesGcmDecrypt(masterKey, enc1.ciphertext, enc1.iv);
    const dec2 = await aesGcmDecrypt(masterKey, enc2.ciphertext, enc2.iv);
    expect(dec1).toEqual(plaintext);
    expect(dec2).toEqual(plaintext);
  });

  it('fails decryption with wrong key', async () => {
    const key1 = crypto.getRandomValues(new Uint8Array(32));
    const key2 = crypto.getRandomValues(new Uint8Array(32));
    const plaintext = new TextEncoder().encode('secret');

    const { ciphertext, iv } = await aesGcmEncrypt(key1, plaintext);

    await expect(aesGcmDecrypt(key2, ciphertext, iv)).rejects.toThrow();
  });

  it('fails decryption with tampered ciphertext', async () => {
    const masterKey = crypto.getRandomValues(new Uint8Array(32));
    const plaintext = new TextEncoder().encode('secret');

    const { ciphertext, iv } = await aesGcmEncrypt(masterKey, plaintext);
    ciphertext[0] ^= 0xff; // Tamper with first byte

    await expect(aesGcmDecrypt(masterKey, ciphertext, iv)).rejects.toThrow();
  });
});

describe('full registration flow', () => {
  it('derives keys, encrypts identity, then decrypts with same password', async () => {
    const password = 'my-secure-password!';
    const salt = crypto.getRandomValues(new Uint8Array(16));

    // Registration: derive keys, create identity bytes, encrypt
    const { masterKey, authKey } = await deriveKeys(password, salt);
    const identityBytes = crypto.getRandomValues(new Uint8Array(64)); // Simulated Ed25519 keypair
    const { ciphertext, iv } = await aesGcmEncrypt(masterKey, identityBytes);

    // authKey would be sent to server (32 bytes)
    expect(authKey.length).toBe(32);

    // Login: derive keys again, decrypt identity from server
    const loginKeys = await deriveKeys(password, salt);
    const decryptedIdentity = await aesGcmDecrypt(
      loginKeys.masterKey,
      ciphertext,
      iv,
    );

    expect(decryptedIdentity).toEqual(identityBytes);
  });
});
