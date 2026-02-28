import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock storage module
vi.mock('./storage.ts', () => ({
  storeKeyBundle: vi.fn().mockResolvedValue(undefined),
  loadKeyBundle: vi.fn().mockResolvedValue(null),
}));

// Mock API module
vi.mock('../api/keys.ts', () => ({
  registerPublicKey: vi.fn().mockResolvedValue(undefined),
}));

// Dynamic imports after mocks
const {
  createIdentity,
  persistIdentity,
  restoreIdentity,
  registerPublicKey,
} = await import('./credentials.ts');

const { storeKeyBundle, loadKeyBundle } = await import('./storage.ts');
const { registerPublicKey: registerPublicKeyRpc } = await import('../api/keys.ts');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('createIdentity', () => {
  it('returns an IdentityKeypair with 32-byte publicKey and 32-byte secretKey', () => {
    const kp = createIdentity();
    expect(kp.publicKey).toBeInstanceOf(Uint8Array);
    expect(kp.secretKey).toBeInstanceOf(Uint8Array);
    expect(kp.publicKey.length).toBe(32);
    expect(kp.secretKey.length).toBe(32);
  });

  it('generates different keypairs each time', () => {
    const kp1 = createIdentity();
    const kp2 = createIdentity();
    expect(kp1.publicKey).not.toEqual(kp2.publicKey);
    expect(kp1.secretKey).not.toEqual(kp2.secretKey);
  });
});

describe('persistIdentity + restoreIdentity', () => {
  it('roundtrips an identity keypair through encrypt/store/load/decrypt', async () => {
    const kp = createIdentity();
    const masterKey = crypto.getRandomValues(new Uint8Array(32));

    // Capture the packed bundle when storeKeyBundle is called
    let storedBundle: Uint8Array | null = null;
    vi.mocked(storeKeyBundle).mockImplementation(async (packed: Uint8Array) => {
      storedBundle = new Uint8Array(packed);
    });

    await persistIdentity(kp, masterKey);

    expect(storeKeyBundle).toHaveBeenCalledTimes(1);
    expect(storedBundle).not.toBeNull();

    // The stored bundle should be [12 bytes IV][ciphertext]
    // ciphertext = 64 bytes identity + 16 bytes GCM tag = 80 bytes
    expect(storedBundle!.length).toBe(12 + 64 + 16);

    // Set up loadKeyBundle to return the stored bundle
    vi.mocked(loadKeyBundle).mockResolvedValue(storedBundle);

    const restored = await restoreIdentity(masterKey);
    expect(restored).not.toBeNull();
    expect(restored!.secretKey).toEqual(kp.secretKey);
    expect(restored!.publicKey).toEqual(kp.publicKey);
  });

  it('restoreIdentity with wrong masterKey throws', async () => {
    const kp = createIdentity();
    const masterKey = crypto.getRandomValues(new Uint8Array(32));
    const wrongKey = crypto.getRandomValues(new Uint8Array(32));

    let storedBundle: Uint8Array | null = null;
    vi.mocked(storeKeyBundle).mockImplementation(async (packed: Uint8Array) => {
      storedBundle = new Uint8Array(packed);
    });

    await persistIdentity(kp, masterKey);

    vi.mocked(loadKeyBundle).mockResolvedValue(storedBundle);

    await expect(restoreIdentity(wrongKey)).rejects.toThrow();
  });

  it('restoreIdentity returns null when no key bundle is stored', async () => {
    const masterKey = crypto.getRandomValues(new Uint8Array(32));
    vi.mocked(loadKeyBundle).mockResolvedValue(null);

    const result = await restoreIdentity(masterKey);
    expect(result).toBeNull();
  });
});

describe('registerPublicKey', () => {
  it('calls the RPC with the correct 32-byte key', async () => {
    const kp = createIdentity();

    await registerPublicKey(kp.publicKey);

    expect(registerPublicKeyRpc).toHaveBeenCalledTimes(1);
    expect(registerPublicKeyRpc).toHaveBeenCalledWith(kp.publicKey);
    // Verify the key passed is 32 bytes
    const calledWith = vi.mocked(registerPublicKeyRpc).mock.calls[0][0];
    expect(calledWith).toBeInstanceOf(Uint8Array);
    expect(calledWith.length).toBe(32);
  });
});
