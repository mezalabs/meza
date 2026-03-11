import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock channel-keys module before importing the module under test.
vi.mock('./channel-keys.ts', () => ({
  getChannelKeysForServer: vi.fn(),
  importChannelKeys: vi.fn(),
}));

const { getChannelKeysForServer, importChannelKeys } = await import(
  './channel-keys.ts'
);
const { createInviteKeyBundle, importInviteKeyBundle } = await import(
  './invite-keys.ts'
);

/** Helper: generate a random 32-byte invite secret. */
function randomSecret(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

/** Helper: base64-encode bytes (mirrors internal bytesToBase64). */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('createInviteKeyBundle / importInviteKeyBundle round-trip', () => {
  it('encrypts and decrypts a bundle, calling importChannelKeys with original data', async () => {
    // Simulate two channels, each with one key version.
    const key1 = crypto.getRandomValues(new Uint8Array(32));
    const key2 = crypto.getRandomValues(new Uint8Array(32));

    const keysPayload: Record<string, Record<string, string>> = {
      'channel-a': { '1': bytesToBase64(key1) },
      'channel-b': { '2': bytesToBase64(key2) },
    };

    vi.mocked(getChannelKeysForServer).mockReturnValue(keysPayload);

    const secret = randomSecret();
    const { ciphertext, iv } = await createInviteKeyBundle(secret, [
      'channel-a',
      'channel-b',
    ]);

    expect(getChannelKeysForServer).toHaveBeenCalledWith([
      'channel-a',
      'channel-b',
    ]);
    expect(ciphertext).toBeInstanceOf(Uint8Array);
    expect(iv).toBeInstanceOf(Uint8Array);
    expect(iv.length).toBe(12);

    // Now import using the same secret.
    await importInviteKeyBundle(secret, ciphertext, iv);

    expect(importChannelKeys).toHaveBeenCalledTimes(1);
    expect(importChannelKeys).toHaveBeenCalledWith(keysPayload);
  });

  it('round-trips a single channel with multiple key versions', async () => {
    const keyV1 = crypto.getRandomValues(new Uint8Array(32));
    const keyV2 = crypto.getRandomValues(new Uint8Array(32));

    const keysPayload: Record<string, Record<string, string>> = {
      'chan-x': {
        '1': bytesToBase64(keyV1),
        '2': bytesToBase64(keyV2),
      },
    };

    vi.mocked(getChannelKeysForServer).mockReturnValue(keysPayload);

    const secret = randomSecret();
    const { ciphertext, iv } = await createInviteKeyBundle(secret, ['chan-x']);

    await importInviteKeyBundle(secret, ciphertext, iv);

    expect(importChannelKeys).toHaveBeenCalledWith(keysPayload);
  });
});

describe('deterministic derivation', () => {
  it('same secret successfully decrypts the bundle it encrypted', async () => {
    const keysPayload: Record<string, Record<string, string>> = {
      ch1: { '1': bytesToBase64(new Uint8Array(32)) },
    };
    vi.mocked(getChannelKeysForServer).mockReturnValue(keysPayload);

    const secret = randomSecret();

    // Encrypt twice with the same secret (different random IVs).
    const bundle1 = await createInviteKeyBundle(secret, ['ch1']);
    const bundle2 = await createInviteKeyBundle(secret, ['ch1']);

    // The ciphertexts differ because aesGcmEncrypt generates a random IV each time.
    expect(bundle1.iv).not.toEqual(bundle2.iv);

    // Both decrypt successfully with the same secret.
    await importInviteKeyBundle(secret, bundle1.ciphertext, bundle1.iv);
    await importInviteKeyBundle(secret, bundle2.ciphertext, bundle2.iv);

    expect(importChannelKeys).toHaveBeenCalledTimes(2);
    expect(importChannelKeys).toHaveBeenNthCalledWith(1, keysPayload);
    expect(importChannelKeys).toHaveBeenNthCalledWith(2, keysPayload);
  });
});

describe('wrong secret fails', () => {
  it('throws when importing with a different secret than the one used to create', async () => {
    const keysPayload: Record<string, Record<string, string>> = {
      ch1: { '1': bytesToBase64(new Uint8Array(32)) },
    };
    vi.mocked(getChannelKeysForServer).mockReturnValue(keysPayload);

    const secretA = randomSecret();
    const secretB = randomSecret();

    const { ciphertext, iv } = await createInviteKeyBundle(secretA, ['ch1']);

    // Decryption with wrong secret should fail (AES-GCM authentication failure).
    await expect(
      importInviteKeyBundle(secretB, ciphertext, iv),
    ).rejects.toThrow();

    // importChannelKeys should never have been called.
    expect(importChannelKeys).not.toHaveBeenCalled();
  });

  it('throws when a single bit is flipped in the secret', async () => {
    const keysPayload: Record<string, Record<string, string>> = {
      ch1: { '1': bytesToBase64(new Uint8Array(32)) },
    };
    vi.mocked(getChannelKeysForServer).mockReturnValue(keysPayload);

    const secret = randomSecret();
    const { ciphertext, iv } = await createInviteKeyBundle(secret, ['ch1']);

    // Flip one bit in the secret.
    const tamperedSecret = new Uint8Array(secret);
    tamperedSecret[0] ^= 0x01;

    await expect(
      importInviteKeyBundle(tamperedSecret, ciphertext, iv),
    ).rejects.toThrow();

    expect(importChannelKeys).not.toHaveBeenCalled();
  });
});

describe('empty channel list', () => {
  it('creates and imports a bundle with no channels', async () => {
    // An empty channel list produces an empty object {}.
    vi.mocked(getChannelKeysForServer).mockReturnValue({});

    const secret = randomSecret();
    const { ciphertext, iv } = await createInviteKeyBundle(secret, []);

    expect(getChannelKeysForServer).toHaveBeenCalledWith([]);
    expect(ciphertext).toBeInstanceOf(Uint8Array);
    expect(ciphertext.length).toBeGreaterThan(0); // GCM auth tag is always present

    await importInviteKeyBundle(secret, ciphertext, iv);

    expect(importChannelKeys).toHaveBeenCalledWith({});
  });
});

describe('tampered ciphertext', () => {
  it('rejects ciphertext with a flipped byte', async () => {
    const keysPayload: Record<string, Record<string, string>> = {
      ch1: { '1': bytesToBase64(new Uint8Array(32)) },
    };
    vi.mocked(getChannelKeysForServer).mockReturnValue(keysPayload);

    const secret = randomSecret();
    const { ciphertext, iv } = await createInviteKeyBundle(secret, ['ch1']);

    // Tamper with the ciphertext.
    const tampered = new Uint8Array(ciphertext);
    tampered[0] ^= 0xff;

    await expect(importInviteKeyBundle(secret, tampered, iv)).rejects.toThrow();

    expect(importChannelKeys).not.toHaveBeenCalled();
  });

  it('rejects ciphertext with a tampered IV', async () => {
    const keysPayload: Record<string, Record<string, string>> = {
      ch1: { '1': bytesToBase64(new Uint8Array(32)) },
    };
    vi.mocked(getChannelKeysForServer).mockReturnValue(keysPayload);

    const secret = randomSecret();
    const { ciphertext, iv } = await createInviteKeyBundle(secret, ['ch1']);

    // Tamper with the IV.
    const tamperedIv = new Uint8Array(iv);
    tamperedIv[0] ^= 0x01;

    await expect(
      importInviteKeyBundle(secret, ciphertext, tamperedIv),
    ).rejects.toThrow();

    expect(importChannelKeys).not.toHaveBeenCalled();
  });
});
