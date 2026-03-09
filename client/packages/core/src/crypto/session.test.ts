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

// Mock localStorage
const localStorageMap = new Map<string, string>();
const mockLocalStorage = {
  getItem: vi.fn((key: string) => localStorageMap.get(key) ?? null),
  setItem: vi.fn((key: string, value: string) =>
    localStorageMap.set(key, value),
  ),
  removeItem: vi.fn((key: string) => localStorageMap.delete(key)),
  clear: vi.fn(() => localStorageMap.clear()),
  get length() {
    return localStorageMap.size;
  },
  key: vi.fn((_index: number) => null),
};
vi.stubGlobal('localStorage', mockLocalStorage);

// Dynamic imports after mocks
const {
  bootstrapSession,
  teardownSession,
  isSessionReady,
  getIdentity,
  onSessionReady,
} = await import('./session.ts');

const { restoreIdentity } = await import('./credentials.ts');
const {
  initChannelKeys,
  loadCachedChannelKeys,
  clearChannelKeyCache,
  flushChannelKeys,
} = await import('./channel-keys.ts');

const fakeKeypair = {
  secretKey: crypto.getRandomValues(new Uint8Array(32)),
  publicKey: crypto.getRandomValues(new Uint8Array(32)),
};

beforeEach(async () => {
  vi.clearAllMocks();
  localStorageMap.clear();

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

  it('with master key caches it in localStorage', async () => {
    const masterKey = crypto.getRandomValues(new Uint8Array(32));
    vi.mocked(restoreIdentity).mockResolvedValue(fakeKeypair);

    await bootstrapSession(masterKey);

    expect(mockLocalStorage.setItem).toHaveBeenCalledWith(
      'meza-mk',
      expect.any(String),
    );
  });

  it('without master key falls back to localStorage', async () => {
    // Pre-populate localStorage with a base64-encoded master key
    const masterKey = crypto.getRandomValues(new Uint8Array(32));
    let binary = '';
    for (let i = 0; i < masterKey.length; i++) {
      binary += String.fromCharCode(masterKey[i]);
    }
    localStorageMap.set('meza-mk', btoa(binary));

    vi.mocked(restoreIdentity).mockResolvedValue(fakeKeypair);

    const result = await bootstrapSession();

    expect(result).toBe(true);
    expect(isSessionReady()).toBe(true);
    expect(restoreIdentity).toHaveBeenCalled();
  });

  it('without master key and no localStorage returns false', async () => {
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

  it('removes master key from localStorage', async () => {
    const masterKey = crypto.getRandomValues(new Uint8Array(32));
    vi.mocked(restoreIdentity).mockResolvedValue(fakeKeypair);

    await bootstrapSession(masterKey);
    vi.clearAllMocks();

    await teardownSession();

    expect(mockLocalStorage.removeItem).toHaveBeenCalledWith('meza-mk');
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

describe('async bootstrap timing', () => {
  it('isSessionReady() returns false while bootstrapSession() is in progress', async () => {
    const masterKey = crypto.getRandomValues(new Uint8Array(32));

    // Use a delayed restoreIdentity to keep bootstrap in progress
    let resolveRestore: (value: typeof fakeKeypair) => void;
    vi.mocked(restoreIdentity).mockImplementation(
      () =>
        new Promise((r) => {
          resolveRestore = r;
        }),
    );

    const bootstrapPromise = bootstrapSession(masterKey);

    // While waiting for restoreIdentity, session should not be ready
    expect(isSessionReady()).toBe(false);
    expect(getIdentity()).toBeNull();

    // Now resolve restoreIdentity
    // biome-ignore lint/style/noNonNullAssertion: resolveRestore is assigned by the mock implementation above
    resolveRestore!(fakeKeypair);
    await bootstrapPromise;

    expect(isSessionReady()).toBe(true);
  });

  it('onSessionReady callback fires only after loadCachedChannelKeys completes', async () => {
    const masterKey = crypto.getRandomValues(new Uint8Array(32));

    // Delay loadCachedChannelKeys to observe ordering
    let resolveLoad: () => void;
    vi.mocked(restoreIdentity).mockResolvedValue(fakeKeypair);
    vi.mocked(loadCachedChannelKeys).mockImplementation(
      () =>
        new Promise<void>((r) => {
          resolveLoad = r;
        }),
    );

    const cb = vi.fn();

    onSessionReady(cb);
    const bootstrapPromise = bootstrapSession(masterKey);

    // Wait for restoreIdentity to resolve and loadCachedChannelKeys to be called
    await vi.waitFor(() => expect(loadCachedChannelKeys).toHaveBeenCalled());

    // Not fired yet — loadCachedChannelKeys hasn't completed
    expect(cb).not.toHaveBeenCalled();

    // biome-ignore lint/style/noNonNullAssertion: resolveLoad is assigned by the mock implementation above
    resolveLoad!();
    await bootstrapPromise;

    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('loadCachedChannelKeys failure does not prevent session from becoming ready', async () => {
    const masterKey = crypto.getRandomValues(new Uint8Array(32));

    vi.mocked(restoreIdentity).mockResolvedValue(fakeKeypair);
    vi.mocked(loadCachedChannelKeys).mockRejectedValue(
      new Error('IndexedDB unavailable'),
    );

    const result = await bootstrapSession(masterKey);

    // Session should still be ready despite loadCachedChannelKeys failure
    expect(result).toBe(true);
    expect(isSessionReady()).toBe(true);
    expect(getIdentity()).toBe(fakeKeypair);
  });
});
