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

vi.mock('./storage.ts', () => ({
  clearCryptoStorage: vi.fn().mockResolvedValue(undefined),
}));

// Mock localStorage (encrypted master key blob is cached here)
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

// Mock sessionStorage (ephemeral session wrapping key lives here)
const sessionStorageMap = new Map<string, string>();
const mockSessionStorage = {
  getItem: vi.fn((key: string) => sessionStorageMap.get(key) ?? null),
  setItem: vi.fn((key: string, value: string) =>
    sessionStorageMap.set(key, value),
  ),
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
const {
  initChannelKeys,
  loadCachedChannelKeys,
  clearChannelKeyCache,
  flushChannelKeys,
} = await import('./channel-keys.ts');

const { clearCryptoStorage } = await import('./storage.ts');

const fakeKeypair = {
  secretKey: crypto.getRandomValues(new Uint8Array(32)),
  publicKey: crypto.getRandomValues(new Uint8Array(32)),
};

beforeEach(async () => {
  vi.clearAllMocks();
  localStorageMap.clear();
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

  it('with master key caches encrypted blob in localStorage and session key in sessionStorage', async () => {
    const masterKey = crypto.getRandomValues(new Uint8Array(32));
    vi.mocked(restoreIdentity).mockResolvedValue(fakeKeypair);

    await bootstrapSession(masterKey);

    // Encrypted master key blob stored in localStorage
    expect(mockLocalStorage.setItem).toHaveBeenCalledWith(
      'meza-mk',
      expect.any(String),
    );
    // Ephemeral session wrapping key stored in sessionStorage
    expect(mockSessionStorage.setItem).toHaveBeenCalledWith(
      'meza-sk',
      expect.any(String),
    );
  });

  it('without master key falls back to encrypted localStorage + sessionStorage', async () => {
    // First bootstrap to populate encrypted storage
    const masterKey = crypto.getRandomValues(new Uint8Array(32));
    vi.mocked(restoreIdentity).mockResolvedValue(fakeKeypair);
    await bootstrapSession(masterKey);

    // Reset session state but keep storage intact (simulates page reload within same tab)
    await teardownSession();
    // teardownSession clears storage, so re-populate it
    // We need a fresh bootstrap → store → teardown(session-only) cycle.
    // Instead, directly test the round-trip by bootstrapping again with
    // the master key, then verifying fallback works.
    await bootstrapSession(masterKey);

    // Grab the stored values before teardown clears them
    const storedMk = localStorageMap.get('meza-mk')!;
    const storedSk = sessionStorageMap.get('meza-sk')!;

    // Teardown resets session state AND clears storage
    await teardownSession();

    // Re-populate storage (simulates same-tab reload where sessionStorage persists)
    localStorageMap.set('meza-mk', storedMk);
    sessionStorageMap.set('meza-sk', storedSk);

    vi.clearAllMocks();
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

  it('without session key in sessionStorage returns false (forces re-auth)', async () => {
    // Bootstrap to populate storage
    const masterKey = crypto.getRandomValues(new Uint8Array(32));
    vi.mocked(restoreIdentity).mockResolvedValue(fakeKeypair);
    await bootstrapSession(masterKey);

    // Grab encrypted blob before teardown clears it
    const storedMk = localStorageMap.get('meza-mk')!;

    await teardownSession();

    // Only restore localStorage (simulates new tab where sessionStorage is empty)
    localStorageMap.set('meza-mk', storedMk);
    // sessionStorage is empty — session key is missing

    vi.clearAllMocks();

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

  it('clears IndexedDB crypto storage', async () => {
    const masterKey = crypto.getRandomValues(new Uint8Array(32));
    vi.mocked(restoreIdentity).mockResolvedValue(fakeKeypair);

    await bootstrapSession(masterKey);
    vi.clearAllMocks();

    await teardownSession();

    expect(clearCryptoStorage).toHaveBeenCalled();
  });

  it('removes encrypted master key from localStorage and session key from sessionStorage', async () => {
    const masterKey = crypto.getRandomValues(new Uint8Array(32));
    vi.mocked(restoreIdentity).mockResolvedValue(fakeKeypair);

    await bootstrapSession(masterKey);
    vi.clearAllMocks();

    await teardownSession();

    expect(mockLocalStorage.removeItem).toHaveBeenCalledWith('meza-mk');
    expect(mockSessionStorage.removeItem).toHaveBeenCalledWith('meza-sk');
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
