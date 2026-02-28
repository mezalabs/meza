import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock dependencies BEFORE importing the module under test
vi.mock('./credentials.ts', () => ({
  restoreIdentity: vi.fn(),
}));

vi.mock('./channel-keys.ts', () => ({
  initChannelKeys: vi.fn(),
  loadCachedChannelKeys: vi.fn().mockResolvedValue(undefined),
  clearChannelKeyCache: vi.fn(),
  flushChannelKeys: vi.fn().mockResolvedValue(undefined),
}));

// Mock sessionStorage
const sessionStorageMap = new Map<string, string>();
const mockSessionStorage = {
  getItem: vi.fn((key: string) => sessionStorageMap.get(key) ?? null),
  setItem: vi.fn((key: string, value: string) => sessionStorageMap.set(key, value)),
  removeItem: vi.fn((key: string) => sessionStorageMap.delete(key)),
  clear: vi.fn(() => sessionStorageMap.clear()),
  get length() {
    return sessionStorageMap.size;
  },
  key: vi.fn((_index: number) => null),
};
vi.stubGlobal('sessionStorage', mockSessionStorage);

// Dynamic imports after mocks
const {
  bootstrapSession,
  teardownSession,
  isSessionReady,
  getIdentity,
  onSessionReady,
} = await import('./session.ts');

const { restoreIdentity } = await import('./credentials.ts');
const { initChannelKeys, loadCachedChannelKeys, clearChannelKeyCache, flushChannelKeys } =
  await import('./channel-keys.ts');

const fakeKeypair = {
  secretKey: crypto.getRandomValues(new Uint8Array(32)),
  publicKey: crypto.getRandomValues(new Uint8Array(32)),
};

beforeEach(async () => {
  vi.clearAllMocks();
  sessionStorageMap.clear();

  // Tear down any existing session to reset internal module state
  await teardownSession();
});

describe('bootstrapSession', () => {
  it('with valid master key sets isSessionReady to true', async () => {
    const masterKey = crypto.getRandomValues(new Uint8Array(32));
    vi.mocked(restoreIdentity).mockResolvedValue(fakeKeypair);

    const result = await bootstrapSession(masterKey);

    expect(result).toBe(true);
    expect(isSessionReady()).toBe(true);
    expect(restoreIdentity).toHaveBeenCalledWith(masterKey);
    expect(initChannelKeys).toHaveBeenCalledWith(fakeKeypair, masterKey);
    expect(loadCachedChannelKeys).toHaveBeenCalled();
  });

  it('stores identity keypair accessible via getIdentity', async () => {
    const masterKey = crypto.getRandomValues(new Uint8Array(32));
    vi.mocked(restoreIdentity).mockResolvedValue(fakeKeypair);

    await bootstrapSession(masterKey);

    expect(getIdentity()).toBe(fakeKeypair);
  });

  it('with master key caches it in sessionStorage', async () => {
    const masterKey = crypto.getRandomValues(new Uint8Array(32));
    vi.mocked(restoreIdentity).mockResolvedValue(fakeKeypair);

    await bootstrapSession(masterKey);

    expect(mockSessionStorage.setItem).toHaveBeenCalledWith(
      'meza-mk',
      expect.any(String),
    );
  });

  it('without master key falls back to sessionStorage', async () => {
    // Pre-populate sessionStorage with a base64-encoded master key
    const masterKey = crypto.getRandomValues(new Uint8Array(32));
    let binary = '';
    for (let i = 0; i < masterKey.length; i++) {
      binary += String.fromCharCode(masterKey[i]);
    }
    sessionStorageMap.set('meza-mk', btoa(binary));

    vi.mocked(restoreIdentity).mockResolvedValue(fakeKeypair);

    const result = await bootstrapSession();

    expect(result).toBe(true);
    expect(isSessionReady()).toBe(true);
    expect(restoreIdentity).toHaveBeenCalled();
  });

  it('without master key and no sessionStorage returns false', async () => {
    const result = await bootstrapSession();

    expect(result).toBe(false);
    expect(isSessionReady()).toBe(false);
    expect(restoreIdentity).not.toHaveBeenCalled();
  });

  it('returns false when restoreIdentity returns null', async () => {
    const masterKey = crypto.getRandomValues(new Uint8Array(32));
    vi.mocked(restoreIdentity).mockResolvedValue(null);

    const result = await bootstrapSession(masterKey);

    expect(result).toBe(false);
    expect(isSessionReady()).toBe(false);
  });

  it('deduplicates concurrent calls (restoreIdentity called once)', async () => {
    const masterKey = crypto.getRandomValues(new Uint8Array(32));
    vi.mocked(restoreIdentity).mockResolvedValue(fakeKeypair);

    // Call bootstrapSession multiple times concurrently
    const [r1, r2, r3] = await Promise.all([
      bootstrapSession(masterKey),
      bootstrapSession(masterKey),
      bootstrapSession(masterKey),
    ]);

    expect(r1).toBe(true);
    expect(r2).toBe(true);
    expect(r3).toBe(true);
    expect(restoreIdentity).toHaveBeenCalledTimes(1);
  });

  it('returns true immediately if already bootstrapped', async () => {
    const masterKey = crypto.getRandomValues(new Uint8Array(32));
    vi.mocked(restoreIdentity).mockResolvedValue(fakeKeypair);

    await bootstrapSession(masterKey);
    vi.clearAllMocks();

    const result = await bootstrapSession(masterKey);

    expect(result).toBe(true);
    // Should not call restoreIdentity again
    expect(restoreIdentity).not.toHaveBeenCalled();
  });
});

describe('teardownSession', () => {
  it('sets isSessionReady to false after teardown', async () => {
    const masterKey = crypto.getRandomValues(new Uint8Array(32));
    vi.mocked(restoreIdentity).mockResolvedValue(fakeKeypair);

    await bootstrapSession(masterKey);
    expect(isSessionReady()).toBe(true);

    await teardownSession();
    expect(isSessionReady()).toBe(false);
  });

  it('clears identity after teardown', async () => {
    const masterKey = crypto.getRandomValues(new Uint8Array(32));
    vi.mocked(restoreIdentity).mockResolvedValue(fakeKeypair);

    await bootstrapSession(masterKey);
    expect(getIdentity()).toBe(fakeKeypair);

    await teardownSession();
    expect(getIdentity()).toBeNull();
  });

  it('flushes channel keys and clears cache', async () => {
    const masterKey = crypto.getRandomValues(new Uint8Array(32));
    vi.mocked(restoreIdentity).mockResolvedValue(fakeKeypair);

    await bootstrapSession(masterKey);
    vi.clearAllMocks();

    await teardownSession();

    expect(flushChannelKeys).toHaveBeenCalled();
    expect(clearChannelKeyCache).toHaveBeenCalled();
  });

  it('removes master key from sessionStorage', async () => {
    const masterKey = crypto.getRandomValues(new Uint8Array(32));
    vi.mocked(restoreIdentity).mockResolvedValue(fakeKeypair);

    await bootstrapSession(masterKey);
    vi.clearAllMocks();

    await teardownSession();

    expect(mockSessionStorage.removeItem).toHaveBeenCalledWith('meza-mk');
  });
});

describe('onSessionReady', () => {
  it('fires callback synchronously when already ready', async () => {
    const masterKey = crypto.getRandomValues(new Uint8Array(32));
    vi.mocked(restoreIdentity).mockResolvedValue(fakeKeypair);

    await bootstrapSession(masterKey);

    const cb = vi.fn();
    onSessionReady(cb);

    // Synchronous — no need to await
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('fires callback when session becomes ready', async () => {
    const cb = vi.fn();
    onSessionReady(cb);

    // Not yet ready
    expect(cb).not.toHaveBeenCalled();

    const masterKey = crypto.getRandomValues(new Uint8Array(32));
    vi.mocked(restoreIdentity).mockResolvedValue(fakeKeypair);
    await bootstrapSession(masterKey);

    // Now ready
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('returns an unsubscribe function that prevents callback', async () => {
    const cb = vi.fn();
    const unsubscribe = onSessionReady(cb);

    // Unsubscribe before session becomes ready
    unsubscribe();

    const masterKey = crypto.getRandomValues(new Uint8Array(32));
    vi.mocked(restoreIdentity).mockResolvedValue(fakeKeypair);
    await bootstrapSession(masterKey);

    // Callback should NOT have been called
    expect(cb).not.toHaveBeenCalled();
  });

  it('unsubscribe from already-ready session is a no-op', async () => {
    const masterKey = crypto.getRandomValues(new Uint8Array(32));
    vi.mocked(restoreIdentity).mockResolvedValue(fakeKeypair);
    await bootstrapSession(masterKey);

    const cb = vi.fn();
    const unsubscribe = onSessionReady(cb);

    // Callback already fired synchronously
    expect(cb).toHaveBeenCalledTimes(1);

    // Unsubscribe is a no-op (doesn't throw)
    unsubscribe();
  });
});
