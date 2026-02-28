import { describe, expect, it } from 'vitest';
import {
  decryptRecoveryBundle,
  deriveRecoveryKey,
  encryptRecoveryBundle,
  generateRecoveryPhrase,
  validateRecoveryPhrase,
} from './recovery.ts';

describe('generateRecoveryPhrase', () => {
  it('returns a string with 12 space-separated words', async () => {
    const phrase = await generateRecoveryPhrase();
    const words = phrase.split(' ');
    expect(words).toHaveLength(12);
    for (const word of words) {
      expect(word.length).toBeGreaterThan(0);
    }
  });

  it('each word is from the BIP39 english wordlist', async () => {
    const { wordlist } = await import('@scure/bip39/wordlists/english.js');
    const phrase = await generateRecoveryPhrase();
    const words = phrase.split(' ');
    for (const word of words) {
      expect(wordlist).toContain(word);
    }
  });

  it('generates different phrases each time', async () => {
    const p1 = await generateRecoveryPhrase();
    const p2 = await generateRecoveryPhrase();
    expect(p1).not.toBe(p2);
  });

  it('produces a valid BIP39 mnemonic', async () => {
    const phrase = await generateRecoveryPhrase();
    const valid = await validateRecoveryPhrase(phrase);
    expect(valid).toBe(true);
  });
});

describe('deriveRecoveryKey', () => {
  it('returns a 32-byte Uint8Array', async () => {
    const phrase = await generateRecoveryPhrase();
    const key = await deriveRecoveryKey(phrase);
    expect(key).toBeInstanceOf(Uint8Array);
    expect(key.length).toBe(32);
  });

  it('is deterministic (same phrase produces same key)', async () => {
    const phrase = await generateRecoveryPhrase();
    const key1 = await deriveRecoveryKey(phrase);
    const key2 = await deriveRecoveryKey(phrase);
    expect(key1).toEqual(key2);
  });

  it('different phrases produce different keys', async () => {
    const phrase1 = await generateRecoveryPhrase();
    const phrase2 = await generateRecoveryPhrase();
    const key1 = await deriveRecoveryKey(phrase1);
    const key2 = await deriveRecoveryKey(phrase2);
    expect(key1).not.toEqual(key2);
  });

  it('is case insensitive (uppercase phrase produces same key)', async () => {
    const phrase = await generateRecoveryPhrase();
    const keyLower = await deriveRecoveryKey(phrase.toLowerCase());
    const keyUpper = await deriveRecoveryKey(phrase.toUpperCase());
    expect(keyLower).toEqual(keyUpper);
  });

  it('normalizes leading and trailing whitespace (trimmed phrase produces same key)', async () => {
    const phrase = await generateRecoveryPhrase();
    const keyClean = await deriveRecoveryKey(phrase);
    const keyPadded = await deriveRecoveryKey(`   ${phrase}   `);
    expect(keyClean).toEqual(keyPadded);
  });
});

describe('encryptRecoveryBundle / decryptRecoveryBundle', () => {
  it('roundtrips successfully', async () => {
    const phrase = await generateRecoveryPhrase();
    const recoveryKey = await deriveRecoveryKey(phrase);
    const plaintext = crypto.getRandomValues(new Uint8Array(64));

    const { ciphertext, iv } = await encryptRecoveryBundle(recoveryKey, plaintext);
    expect(ciphertext).toBeInstanceOf(Uint8Array);
    expect(iv).toBeInstanceOf(Uint8Array);
    expect(iv.length).toBe(12);

    const decrypted = await decryptRecoveryBundle(recoveryKey, ciphertext, iv);
    expect(decrypted).toEqual(plaintext);
  });

  it('decrypts to original identity bytes', async () => {
    const phrase = await generateRecoveryPhrase();
    const recoveryKey = await deriveRecoveryKey(phrase);
    const identityBytes = new TextEncoder().encode('fake-identity-keypair-64-bytes!!fake-identity-keypair-64-bytes!!');

    const { ciphertext, iv } = await encryptRecoveryBundle(recoveryKey, identityBytes);
    const decrypted = await decryptRecoveryBundle(recoveryKey, ciphertext, iv);
    expect(new TextDecoder().decode(decrypted)).toBe(
      'fake-identity-keypair-64-bytes!!fake-identity-keypair-64-bytes!!',
    );
  });

  it('throws with wrong recovery key', async () => {
    const phrase1 = await generateRecoveryPhrase();
    const phrase2 = await generateRecoveryPhrase();
    const recoveryKey1 = await deriveRecoveryKey(phrase1);
    const recoveryKey2 = await deriveRecoveryKey(phrase2);
    const plaintext = crypto.getRandomValues(new Uint8Array(64));

    const { ciphertext, iv } = await encryptRecoveryBundle(recoveryKey1, plaintext);
    await expect(
      decryptRecoveryBundle(recoveryKey2, ciphertext, iv),
    ).rejects.toThrow();
  });

  it('produces different ciphertext each time (random IV)', async () => {
    const phrase = await generateRecoveryPhrase();
    const recoveryKey = await deriveRecoveryKey(phrase);
    const plaintext = crypto.getRandomValues(new Uint8Array(64));

    const enc1 = await encryptRecoveryBundle(recoveryKey, plaintext);
    const enc2 = await encryptRecoveryBundle(recoveryKey, plaintext);

    // IVs should differ
    expect(enc1.iv).not.toEqual(enc2.iv);
    // Ciphertext should differ
    expect(enc1.ciphertext).not.toEqual(enc2.ciphertext);

    // Both decrypt to the same plaintext
    const dec1 = await decryptRecoveryBundle(recoveryKey, enc1.ciphertext, enc1.iv);
    const dec2 = await decryptRecoveryBundle(recoveryKey, enc2.ciphertext, enc2.iv);
    expect(dec1).toEqual(plaintext);
    expect(dec2).toEqual(plaintext);
  });
});

describe('validateRecoveryPhrase', () => {
  it('returns true for a valid generated phrase', async () => {
    const phrase = await generateRecoveryPhrase();
    expect(await validateRecoveryPhrase(phrase)).toBe(true);
  });

  it('returns false for garbage input', async () => {
    expect(await validateRecoveryPhrase('not a valid mnemonic phrase at all yo dude')).toBe(false);
  });

  it('validates case-insensitively', async () => {
    const phrase = await generateRecoveryPhrase();
    expect(await validateRecoveryPhrase(phrase.toUpperCase())).toBe(true);
  });

  it('validates with extra whitespace', async () => {
    const phrase = await generateRecoveryPhrase();
    expect(await validateRecoveryPhrase(`  ${phrase}  `)).toBe(true);
  });
});
