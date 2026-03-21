import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateIdentityKeypair } from './primitives.ts';

// Mock storage
vi.mock('./storage.ts', () => ({
  storeKeyBundle: vi.fn(),
  loadKeyBundle: vi.fn().mockResolvedValue(null),
  storeChannelKeys: vi.fn(),
  loadChannelKeys: vi.fn().mockResolvedValue(null),
  clearCryptoStorage: vi.fn(),
}));

// Mock API
vi.mock('../api/keys.ts', () => ({
  registerPublicKey: vi.fn(),
  getKeyEnvelopes: vi.fn(),
  storeKeyEnvelopes: vi.fn(),
  rotateChannelKeyRpc: vi.fn(),
  listMembersWithViewChannel: vi.fn(),
}));

// We need restoreIdentity to be controllable for race scenarios
vi.mock('./credentials.ts', () => ({
  restoreIdentity: vi.fn(),
}));

// Mock sessionStorage
const sessionStorageMap = new Map<string, string>();
vi.stubGlobal('sessionStorage', {
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
});

// Stub BroadcastChannel to prevent cross-test message leakage
vi.stubGlobal(
  'BroadcastChannel',
  class {
    onmessage: ((ev: MessageEvent) => void) | null = null;
    postMessage() {}
    close() {}
  },
);

// Mock localStorage (used by persistentStorage() in clearMasterKey)
const localStorageMap = new Map<string, string>();
vi.stubGlobal('localStorage', {
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
});

// Dynamic imports after mocks
const { bootstrapSession, teardownSession, getIdentity, onSessionReady } =
  await import('./session.ts');

const { createChannelKey, fetchAndCacheChannelKeys } = await import(
  './channel-keys.ts'
);

const { encryptMessage } = await import('./messages.ts');
const { unwrapFileKey, wrapFileKey, generateFileKey } = await import(
  './file-encryption.ts'
);
const { restoreIdentity } = await import('./credentials.ts');

const alice = generateIdentityKeypair();

beforeEach(async () => {
  vi.clearAllMocks();
  sessionStorageMap.clear();
  localStorageMap.clear();
  await teardownSession();
});

describe('race: crypto operations before bootstrap', () => {
  it('unwrapFileKey called before bootstrapSession rejects with "Channel keys not initialized"', async () => {
    // No bootstrap — identity is null, no channel keys
    const fakeEnvelope = new Uint8Array(64);
    new DataView(fakeEnvelope.buffer).setUint32(0, 1);

    await expect(unwrapFileKey('ch1', fakeEnvelope)).rejects.toThrow(
      'Channel keys not initialized',
    );
  });

  it('encryptMessage fails when identity is null (session not ready)', async () => {
    // No bootstrap — getIdentity() returns null
    const content = new TextEncoder().encode('test');

    await expect(encryptMessage('ch1', content)).rejects.toThrow(
      'E2EE session not initialized',
    );
  });

  it('fetchAndCacheChannelKeys fails when session not ready', async () => {
    await expect(fetchAndCacheChannelKeys('ch1')).rejects.toThrow(
      'Channel keys not initialized',
    );
  });
});

describe('race: waiting for session ready before operations', () => {
  it('onSessionReady callback that calls crypto operations succeeds', async () => {
    const masterKey = crypto.getRandomValues(new Uint8Array(32));
    vi.mocked(restoreIdentity).mockResolvedValue(alice);

    let resolvedInCallback = false;

    // Register a callback that performs crypto operations after session ready
    onSessionReady(() => {
      // At this point session is ready and identity is set
      // Create channel key synchronously (initChannelKeys was called by bootstrap)
      createChannelKey('01HZXK5M8E3J6Q9P2RVTYWN4AB');
      resolvedInCallback = true;
    });

    await bootstrapSession(masterKey);

    expect(resolvedInCallback).toBe(true);

    // Verify the key is usable
    const fileKey = generateFileKey();
    const envelope = await wrapFileKey('01HZXK5M8E3J6Q9P2RVTYWN4AB', fileKey);
    const unwrapResult = await unwrapFileKey(
      '01HZXK5M8E3J6Q9P2RVTYWN4AB',
      envelope,
    );
    expect(unwrapResult).toEqual(fileKey);
  });

  it('decrypt initiated during bootstrap succeeds after bootstrap completes', async () => {
    const masterKey = crypto.getRandomValues(new Uint8Array(32));

    // Delay restoreIdentity so we can observe the "during bootstrap" window
    let resolveRestore: (value: typeof alice) => void;
    vi.mocked(restoreIdentity).mockImplementation(
      () =>
        new Promise((r) => {
          resolveRestore = r;
        }),
    );

    const bootstrapPromise = bootstrapSession(masterKey);

    // Session not ready yet
    expect(getIdentity()).toBeNull();

    // Register a callback to perform operations once ready
    let operationSucceeded = false;
    onSessionReady(() => {
      operationSucceeded = true;
    });

    // Resolve the delayed restoreIdentity
    // biome-ignore lint/style/noNonNullAssertion: resolveRestore is assigned by the mock implementation above
    resolveRestore!(alice);
    await bootstrapPromise;

    expect(operationSucceeded).toBe(true);
    expect(getIdentity()).toBe(alice);
  });
});
