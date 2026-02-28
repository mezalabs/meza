import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock API module
vi.mock('../api/keys.ts', () => ({
  getKeyEnvelopes: vi.fn(),
  storeKeyEnvelopes: vi.fn(),
  rotateChannelKeyRpc: vi.fn(),
}));

// Mock storage module
vi.mock('./storage.ts', () => ({
  storeChannelKeys: vi.fn(),
  loadChannelKeys: vi.fn().mockResolvedValue(null),
}));

const { clearChannelKeyCache, createChannelKey, initChannelKeys } =
  await import('./channel-keys.ts');

const { generateIdentityKeypair } = await import('./primitives.ts');

const alice = generateIdentityKeypair();

vi.mock('./session.ts', () => ({
  getIdentity: vi.fn(() => alice),
}));

const {
  generateFileKey,
  encryptFile,
  decryptFile,
  wrapFileKey,
  unwrapFileKey,
} = await import('./file-encryption.ts');

beforeEach(() => {
  vi.clearAllMocks();
  clearChannelKeyCache();
  const masterKey = new Uint8Array(32);
  crypto.getRandomValues(masterKey);
  initChannelKeys(alice, masterKey);
});

describe('generateFileKey', () => {
  it('generates a 32-byte random key', () => {
    const key = generateFileKey();
    expect(key).toBeInstanceOf(Uint8Array);
    expect(key.length).toBe(32);
  });

  it('generates different keys each time', () => {
    const k1 = generateFileKey();
    const k2 = generateFileKey();
    expect(k1).not.toEqual(k2);
  });
});

describe('encryptFile / decryptFile', () => {
  it('round-trips file bytes', async () => {
    const fileKey = generateFileKey();
    const fileBytes = new TextEncoder().encode('hello image data');

    const encrypted = await encryptFile(fileKey, fileBytes);
    const decrypted = await decryptFile(fileKey, encrypted);

    expect(decrypted).toEqual(fileBytes);
  });

  it('round-trips binary data', async () => {
    const fileKey = generateFileKey();
    const fileBytes = new Uint8Array(10000);
    crypto.getRandomValues(fileBytes);

    const encrypted = await encryptFile(fileKey, fileBytes);
    const decrypted = await decryptFile(fileKey, encrypted);

    expect(decrypted).toEqual(fileBytes);
  });

  it('round-trips empty data', async () => {
    const fileKey = generateFileKey();
    const empty = new Uint8Array(0);

    const encrypted = await encryptFile(fileKey, empty);
    const decrypted = await decryptFile(fileKey, encrypted);

    expect(decrypted.length).toBe(0);
  });

  it('encrypted output is nonce(12) + plaintext + tag(16)', async () => {
    const fileKey = generateFileKey();
    const fileBytes = new Uint8Array(100);

    const encrypted = await encryptFile(fileKey, fileBytes);
    expect(encrypted.length).toBe(12 + 100 + 16);
  });

  it('fails decryption with wrong key', async () => {
    const k1 = generateFileKey();
    const k2 = generateFileKey();
    const fileBytes = new TextEncoder().encode('secret');

    const encrypted = await encryptFile(k1, fileBytes);
    await expect(decryptFile(k2, encrypted)).rejects.toThrow();
  });

  it('produces different ciphertext each time (random nonce)', async () => {
    const fileKey = generateFileKey();
    const fileBytes = new TextEncoder().encode('same data');

    const enc1 = await encryptFile(fileKey, fileBytes);
    const enc2 = await encryptFile(fileKey, fileBytes);
    expect(enc1).not.toEqual(enc2);
  });
});

describe('wrapFileKey / unwrapFileKey', () => {
  it('round-trips a file key through channel key wrapping', async () => {
    createChannelKey('ch1');
    const fileKey = generateFileKey();

    const envelope = await wrapFileKey('ch1', fileKey);
    // envelope = keyVersion(4) + nonce(12) + ciphertext(32) + tag(16) = 64 bytes
    expect(envelope.length).toBe(64);
    // First 4 bytes are key version (big-endian), should be 1
    const version = new DataView(
      envelope.buffer,
      envelope.byteOffset,
      4,
    ).getUint32(0);
    expect(version).toBe(1);

    const unwrapped = await unwrapFileKey('ch1', envelope);
    expect(unwrapped).toEqual(fileKey);
  });

  it('throws when no channel key exists', async () => {
    const fileKey = generateFileKey();
    await expect(wrapFileKey('unknown-ch', fileKey)).rejects.toThrow(
      'No channel key available',
    );
  });

  it('produces different wrapped keys for same file key (random nonce)', async () => {
    createChannelKey('ch1');
    const fileKey = generateFileKey();

    const w1 = await wrapFileKey('ch1', fileKey);
    const w2 = await wrapFileKey('ch1', fileKey);
    expect(w1).not.toEqual(w2);
  });

  it('fails unwrap with tampered key version', async () => {
    createChannelKey('ch1');
    const fileKey = generateFileKey();

    const envelope = await wrapFileKey('ch1', fileKey);
    // Tamper with the key version to a non-existent version
    const tampered = new Uint8Array(envelope);
    new DataView(tampered.buffer).setUint32(0, 999);
    await expect(unwrapFileKey('ch1', tampered)).rejects.toThrow();
  });

  it('throws for too-short encrypted key', async () => {
    await expect(
      unwrapFileKey('ch1', new Uint8Array(3)),
    ).rejects.toThrow('Invalid encrypted key: too short');
  });
});

describe('full file encryption flow', () => {
  it('encrypt file + wrap key → unwrap key + decrypt file', async () => {
    createChannelKey('ch1');

    // Sender side
    const fileKey = generateFileKey();
    const original = new Uint8Array(5000);
    crypto.getRandomValues(original);

    const encryptedFile = await encryptFile(fileKey, original);
    const envelope = await wrapFileKey('ch1', fileKey);

    // Recipient side
    const recoveredKey = await unwrapFileKey('ch1', envelope);
    const decryptedFile = await decryptFile(recoveredKey, encryptedFile);

    expect(decryptedFile).toEqual(original);
  });

  it('encrypt file + thumbnail with same key', async () => {
    const fileKey = generateFileKey();
    const fileData = new Uint8Array(1000);
    const thumbData = new Uint8Array(200);
    crypto.getRandomValues(fileData);
    crypto.getRandomValues(thumbData);

    const encFile = await encryptFile(fileKey, fileData);
    const encThumb = await encryptFile(fileKey, thumbData);

    const decFile = await decryptFile(fileKey, encFile);
    const decThumb = await decryptFile(fileKey, encThumb);

    expect(decFile).toEqual(fileData);
    expect(decThumb).toEqual(thumbData);
  });
});
