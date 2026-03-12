import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tests for BroadcastChannel-based cross-tab session key sharing.
 *
 * These tests mock BroadcastChannel to simulate multi-tab scenarios
 * within a single process. The mock delivers messages synchronously
 * via queueMicrotask to all other instances on the same channel name.
 */

// ---------------------------------------------------------------------------
// Mock BroadcastChannel
// ---------------------------------------------------------------------------

type MessageHandler = ((event: MessageEvent) => void) | null;

class MockBroadcastChannel {
  static instances: MockBroadcastChannel[] = [];

  name: string;
  onmessage: MessageHandler = null;
  closed = false;

  constructor(name: string) {
    this.name = name;
    MockBroadcastChannel.instances.push(this);
  }

  postMessage(data: unknown): void {
    if (this.closed) return;
    // Deliver to all OTHER open instances on the same channel name
    for (const instance of [...MockBroadcastChannel.instances]) {
      if (
        instance !== this &&
        instance.name === this.name &&
        !instance.closed &&
        instance.onmessage
      ) {
        const handler = instance.onmessage;
        // Use queueMicrotask to match real BroadcastChannel async delivery
        queueMicrotask(() => handler(new MessageEvent('message', { data })));
      }
    }
  }

  close(): void {
    this.closed = true;
    this.onmessage = null;
    const idx = MockBroadcastChannel.instances.indexOf(this);
    if (idx >= 0) MockBroadcastChannel.instances.splice(idx, 1);
  }

  static reset(): void {
    for (const instance of [...MockBroadcastChannel.instances]) {
      instance.close();
    }
    MockBroadcastChannel.instances = [];
  }
}

// ---------------------------------------------------------------------------
// Mock dependencies (same pattern as session.test.ts)
// ---------------------------------------------------------------------------

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

// Mock sessionStorage
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

// Stub BroadcastChannel globally for all tests in this file
vi.stubGlobal('BroadcastChannel', MockBroadcastChannel);

// Dynamic imports after mocks
const {
  bootstrapSession,
  teardownSession,
  isSessionReady,
  onCrossTabTeardown,
} = await import('./session.ts');

const { restoreIdentity } = await import('./credentials.ts');

const fakeKeypair = {
  secretKey: crypto.getRandomValues(new Uint8Array(32)),
  publicKey: crypto.getRandomValues(new Uint8Array(32)),
};

beforeEach(async () => {
  vi.clearAllMocks();
  localStorageMap.clear();
  sessionStorageMap.clear();
  MockBroadcastChannel.reset();
  await teardownSession(false);
});

afterEach(() => {
  MockBroadcastChannel.reset();
});

// ---------------------------------------------------------------------------
// Helper: bootstrap a session and capture the stored session key + blob
// ---------------------------------------------------------------------------

async function bootstrapAndCaptureKeys() {
  const masterKey = crypto.getRandomValues(new Uint8Array(32));
  vi.mocked(restoreIdentity).mockResolvedValue(fakeKeypair);
  await bootstrapSession(masterKey);

  const storedMk = localStorageMap.get('meza-mk') ?? '';
  const storedSk = sessionStorageMap.get('meza-sk') ?? '';
  return { masterKey, storedMk, storedSk };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('cross-tab session key sharing via BroadcastChannel', () => {
  it('new tab receives session key from peer tab and bootstraps successfully', async () => {
    // Tab A: bootstrap to populate storage and start the responder
    const { storedMk, storedSk } = await bootstrapAndCaptureKeys();

    // Teardown Tab A's session state (but remember the session key)
    await teardownSession(false);

    // Simulate "another tab" that responds with the session key.
    // Since teardown closed the responder, we manually set one up.
    const peerResponder = new MockBroadcastChannel('meza-session-sync');
    peerResponder.onmessage = (event: MessageEvent) => {
      if (event.data?.type === 'session-key-request') {
        peerResponder.postMessage({
          type: 'session-key-response',
          key: storedSk,
        });
      }
    };

    // Set up the "new tab" state: localStorage has the blob, sessionStorage is empty
    localStorageMap.set('meza-mk', storedMk);
    // sessionStorage is empty (simulates new tab)

    vi.clearAllMocks();
    vi.mocked(restoreIdentity).mockResolvedValue(fakeKeypair);

    // Bootstrap without masterKey — should use BroadcastChannel
    const result = await bootstrapSession();

    expect(result).toBe(true);
    expect(isSessionReady()).toBe(true);
    expect(restoreIdentity).toHaveBeenCalled();

    // Session key should be persisted to sessionStorage after successful decryption
    expect(sessionStorageMap.has('meza-sk')).toBe(true);

    peerResponder.close();
  });

  it('bootstrap fails when no peer responds (timeout)', async () => {
    // Set up localStorage with a blob but no sessionStorage and no peer tab
    const { storedMk } = await bootstrapAndCaptureKeys();
    await teardownSession(false);

    localStorageMap.set('meza-mk', storedMk);
    // No peer responder — request will timeout

    vi.clearAllMocks();

    const result = await bootstrapSession();

    expect(result).toBe(false);
    expect(isSessionReady()).toBe(false);
    // sessionStorage should NOT have a session key
    expect(sessionStorageMap.has('meza-sk')).toBe(false);
  });

  it('does not persist session key to sessionStorage if decryption fails (poisoned key)', async () => {
    // Bootstrap to get a valid blob in localStorage
    const { storedMk } = await bootstrapAndCaptureKeys();
    await teardownSession(false);

    // Peer responds with a WRONG session key
    const peerResponder = new MockBroadcastChannel('meza-session-sync');
    peerResponder.onmessage = (event: MessageEvent) => {
      if (event.data?.type === 'session-key-request') {
        // Send a valid-looking but wrong base64 key
        const wrongKey = btoa(
          String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))),
        );
        peerResponder.postMessage({
          type: 'session-key-response',
          key: wrongKey,
        });
      }
    };

    localStorageMap.set('meza-mk', storedMk);
    vi.clearAllMocks();

    const result = await bootstrapSession();

    expect(result).toBe(false);
    // The wrong key should NOT be persisted to sessionStorage
    expect(sessionStorageMap.has('meza-sk')).toBe(false);

    peerResponder.close();
  });

  it('bootstrapped tab responds to session-key-request from new tabs', async () => {
    // Bootstrap tab A — this starts the responder
    await bootstrapAndCaptureKeys();

    // Simulate a "new tab" requesting the session key
    const received: string[] = [];
    const requester = new MockBroadcastChannel('meza-session-sync');
    requester.onmessage = (event: MessageEvent) => {
      if (event.data?.type === 'session-key-response') {
        received.push(event.data.key);
      }
    };

    requester.postMessage({ type: 'session-key-request' });

    // Allow microtasks to flush (request delivery + response delivery)
    await new Promise((r) => setTimeout(r, 10));

    expect(received).toHaveLength(1);
    expect(received[0]).toBe(sessionStorageMap.get('meza-sk'));

    requester.close();
  });

  it('session-key-update from another tab updates sessionStorage', async () => {
    // Bootstrap to start the responder (which listens for updates)
    await bootstrapAndCaptureKeys();
    const originalSk = sessionStorageMap.get('meza-sk');

    // Simulate another tab broadcasting a session key update
    const updater = new MockBroadcastChannel('meza-session-sync');
    const newKey = btoa(
      String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))),
    );
    updater.postMessage({ type: 'session-key-update', key: newKey });

    // Allow microtask delivery
    await new Promise((r) => setTimeout(r, 10));

    // This tab's sessionStorage should now have the new key
    expect(sessionStorageMap.get('meza-sk')).toBe(newKey);
    expect(sessionStorageMap.get('meza-sk')).not.toBe(originalSk);

    updater.close();
  });

  it('storeMasterKey broadcasts session-key-update to other tabs', async () => {
    // We can observe the broadcast by listening on the channel BEFORE bootstrap.
    // Bootstrap calls storeMasterKey(masterKey) which should broadcast.
    const updates: string[] = [];
    const listener = new MockBroadcastChannel('meza-session-sync');
    listener.onmessage = (event: MessageEvent) => {
      if (event.data?.type === 'session-key-update') {
        updates.push(event.data.key);
      }
    };

    const masterKey = crypto.getRandomValues(new Uint8Array(32));
    vi.mocked(restoreIdentity).mockResolvedValue(fakeKeypair);
    await bootstrapSession(masterKey);

    // Allow microtask delivery
    await new Promise((r) => setTimeout(r, 10));

    expect(updates).toHaveLength(1);
    // The broadcast key should match what's in sessionStorage
    expect(updates[0]).toBe(sessionStorageMap.get('meza-sk'));

    listener.close();
  });
});

describe('cross-tab logout via BroadcastChannel', () => {
  it('teardownSession broadcasts session-teardown when broadcast=true', async () => {
    await bootstrapAndCaptureKeys();

    const received: unknown[] = [];
    const listener = new MockBroadcastChannel('meza-session-sync');
    listener.onmessage = (event: MessageEvent) => {
      if (event.data?.type === 'session-teardown') {
        received.push(event.data);
      }
    };

    await teardownSession(true);

    // Allow microtask delivery
    await new Promise((r) => setTimeout(r, 10));

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ type: 'session-teardown' });

    listener.close();
  });

  it('teardownSession does NOT broadcast when broadcast=false', async () => {
    await bootstrapAndCaptureKeys();

    const received: unknown[] = [];
    const listener = new MockBroadcastChannel('meza-session-sync');
    listener.onmessage = (event: MessageEvent) => {
      received.push(event.data);
    };

    await teardownSession(false);

    // Allow microtask delivery
    await new Promise((r) => setTimeout(r, 10));

    // No messages should have been sent
    expect(received).toHaveLength(0);

    listener.close();
  });

  it('receiving session-teardown tears down local session and fires onCrossTabTeardown', async () => {
    await bootstrapAndCaptureKeys();
    expect(isSessionReady()).toBe(true);

    const cb = vi.fn();
    const unsub = onCrossTabTeardown(cb);

    // Simulate another tab broadcasting session-teardown
    const broadcaster = new MockBroadcastChannel('meza-session-sync');
    broadcaster.postMessage({ type: 'session-teardown' });

    // Allow delivery + teardown + callback
    await new Promise((r) => setTimeout(r, 50));

    expect(isSessionReady()).toBe(false);
    expect(cb).toHaveBeenCalledTimes(1);

    unsub();
    broadcaster.close();
  });

  it('onCrossTabTeardown unsubscribe prevents callback', async () => {
    await bootstrapAndCaptureKeys();

    const cb = vi.fn();
    const unsub = onCrossTabTeardown(cb);
    unsub(); // Unsubscribe immediately

    // Simulate another tab broadcasting session-teardown
    const broadcaster = new MockBroadcastChannel('meza-session-sync');
    broadcaster.postMessage({ type: 'session-teardown' });

    await new Promise((r) => setTimeout(r, 50));

    // Callback should NOT have been called
    expect(cb).not.toHaveBeenCalled();

    broadcaster.close();
  });

  it('does not broadcast session-teardown if session is not active', async () => {
    // Session is not bootstrapped — teardown should not broadcast
    const received: unknown[] = [];
    const listener = new MockBroadcastChannel('meza-session-sync');
    listener.onmessage = (event: MessageEvent) => {
      received.push(event.data);
    };

    await teardownSession(true);

    await new Promise((r) => setTimeout(r, 10));

    expect(received).toHaveLength(0);

    listener.close();
  });
});

describe('BroadcastChannel message validation', () => {
  it('responder ignores malformed messages', async () => {
    await bootstrapAndCaptureKeys();

    const received: unknown[] = [];
    const requester = new MockBroadcastChannel('meza-session-sync');
    requester.onmessage = (event: MessageEvent) => {
      received.push(event.data);
    };

    // Send various malformed messages
    requester.postMessage(null);
    requester.postMessage('not an object');
    requester.postMessage({ type: 'unknown-type' });
    requester.postMessage({ type: 'session-key-response' }); // missing key
    requester.postMessage({ type: 'session-key-response', key: 42 }); // key not string

    await new Promise((r) => setTimeout(r, 10));

    // No responses should have been sent for any of these
    expect(received).toHaveLength(0);

    requester.close();
  });

  it('requester ignores malformed responses', async () => {
    // Set up localStorage with a blob
    const { storedMk } = await bootstrapAndCaptureKeys();
    await teardownSession(false);

    // Peer that sends malformed responses followed by a valid one
    const peerResponder = new MockBroadcastChannel('meza-session-sync');
    let requestCount = 0;
    peerResponder.onmessage = (event: MessageEvent) => {
      if (event.data?.type === 'session-key-request') {
        requestCount++;
        // Send malformed responses — these should be ignored
        peerResponder.postMessage({ type: 'session-key-response' }); // no key
        peerResponder.postMessage({
          type: 'session-key-response',
          key: 123,
        }); // key not string
        peerResponder.postMessage({ type: 'wrong-type', key: 'abc' });
      }
    };

    localStorageMap.set('meza-mk', storedMk);
    vi.clearAllMocks();

    // This should timeout because no valid response was sent
    const result = await bootstrapSession();

    expect(result).toBe(false);
    expect(requestCount).toBe(1);

    peerResponder.close();
  });
});
