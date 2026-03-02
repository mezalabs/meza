import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  decryptPayload,
  encryptPayload,
  generateChannelKey,
  generateIdentityKeypair,
  unwrapChannelKey,
  wrapChannelKey,
} from './primitives.ts';

// Mock the API module
vi.mock('../api/keys.ts', () => ({
  getKeyEnvelopes: vi.fn(),
  storeKeyEnvelopes: vi.fn(),
  rotateChannelKeyRpc: vi.fn(),
  listMembersWithViewChannel: vi.fn(),
}));

// Mock storage module
vi.mock('./storage.ts', () => ({
  storeChannelKeys: vi.fn(),
  loadChannelKeys: vi.fn().mockResolvedValue(null),
}));

// Must import AFTER mocks are set up
const {
  clearChannelKeyCache,
  createChannelKey,
  distributeKeyToMember,
  fetchAndCacheChannelKeys,
  flushChannelKeys,
  getCachedChannelIds,
  getChannelKey,
  getLatestKeyVersion,
  hasChannelKey,
  initChannelKeys,
  lazyInitChannelKey,
  loadCachedChannelKeys,
  rotateChannelKey,
  wrapKeyForMembers,
} = await import('./channel-keys.ts');

const {
  getKeyEnvelopes,
  storeKeyEnvelopes,
  rotateChannelKeyRpc,
  listMembersWithViewChannel,
} = await import('../api/keys.ts');

const { storeChannelKeys, loadChannelKeys } = await import('./storage.ts');

const alice = generateIdentityKeypair();
const bob = generateIdentityKeypair();

beforeEach(() => {
  vi.clearAllMocks();
  clearChannelKeyCache();
  const masterKey = new Uint8Array(32);
  crypto.getRandomValues(masterKey);
  initChannelKeys(alice, masterKey);
});

describe('createChannelKey', () => {
  it('generates a 32-byte key at version 1', () => {
    const { key, version } = createChannelKey('ch1');
    expect(key).toBeInstanceOf(Uint8Array);
    expect(key.length).toBe(32);
    expect(version).toBe(1);
  });

  it('caches the key for retrieval', async () => {
    const { key, version } = createChannelKey('ch1');
    const retrieved = await getChannelKey('ch1', version);
    expect(retrieved).toEqual(key);
  });

  it('marks channel as having a key', () => {
    expect(hasChannelKey('ch1')).toBe(false);
    createChannelKey('ch1');
    expect(hasChannelKey('ch1')).toBe(true);
  });
});

describe('getLatestKeyVersion', () => {
  it('returns null for unknown channel', () => {
    expect(getLatestKeyVersion('unknown')).toBeNull();
  });

  it('returns the latest version', () => {
    createChannelKey('ch1');
    expect(getLatestKeyVersion('ch1')).toBe(1);
  });
});

describe('wrapKeyForMembers', () => {
  it('wraps a channel key for multiple recipients', async () => {
    const channelKey = generateChannelKey();
    const members = new Map<string, Uint8Array>([
      ['alice', alice.publicKey],
      ['bob', bob.publicKey],
    ]);

    const envelopes = await wrapKeyForMembers(channelKey, members);
    expect(envelopes).toHaveLength(2);

    // Each envelope should be 92 bytes
    for (const { envelope } of envelopes) {
      expect(envelope.length).toBe(92);
    }

    // Alice can unwrap her envelope
    // biome-ignore lint/style/noNonNullAssertion: test assertion — value is guaranteed by test setup
    const aliceEnvelope = envelopes.find((e) => e.userId === 'alice')!;
    const unwrapped = await unwrapChannelKey(
      aliceEnvelope.envelope,
      alice.secretKey,
    );
    expect(unwrapped).toEqual(channelKey);

    // Bob can unwrap his envelope
    // biome-ignore lint/style/noNonNullAssertion: test assertion — value is guaranteed by test setup
    const bobEnvelope = envelopes.find((e) => e.userId === 'bob')!;
    const unwrappedBob = await unwrapChannelKey(
      bobEnvelope.envelope,
      bob.secretKey,
    );
    expect(unwrappedBob).toEqual(channelKey);
  });
});

describe('fetchAndCacheChannelKeys', () => {
  it('fetches envelopes from server and caches them', async () => {
    const channelKey = generateChannelKey();
    const envelope = await wrapChannelKey(channelKey, alice.publicKey);

    vi.mocked(getKeyEnvelopes).mockResolvedValue([{ keyVersion: 1, envelope }]);

    await fetchAndCacheChannelKeys('ch1');

    expect(getKeyEnvelopes).toHaveBeenCalledWith('ch1');
    expect(hasChannelKey('ch1')).toBe(true);

    const retrieved = await getChannelKey('ch1', 1);
    expect(retrieved).toEqual(channelKey);
  });

  it('handles empty envelope list', async () => {
    vi.mocked(getKeyEnvelopes).mockResolvedValue([]);

    await fetchAndCacheChannelKeys('ch1');
    expect(hasChannelKey('ch1')).toBe(false);
  });

  it('caches multiple key versions', async () => {
    const key1 = generateChannelKey();
    const key2 = generateChannelKey();
    const env1 = await wrapChannelKey(key1, alice.publicKey);
    const env2 = await wrapChannelKey(key2, alice.publicKey);

    vi.mocked(getKeyEnvelopes).mockResolvedValue([
      { keyVersion: 1, envelope: env1 },
      { keyVersion: 2, envelope: env2 },
    ]);

    await fetchAndCacheChannelKeys('ch1');

    expect(await getChannelKey('ch1', 1)).toEqual(key1);
    expect(await getChannelKey('ch1', 2)).toEqual(key2);
    expect(getLatestKeyVersion('ch1')).toBe(2);
  });
});

describe('distributeKeyToMember', () => {
  it('wraps the current key and uploads via API', async () => {
    createChannelKey('ch1');

    vi.mocked(storeKeyEnvelopes).mockResolvedValue();

    await distributeKeyToMember('ch1', 'bob', bob.publicKey);

    expect(storeKeyEnvelopes).toHaveBeenCalledWith(
      'ch1',
      1,
      expect.arrayContaining([
        expect.objectContaining({
          userId: 'bob',
          envelope: expect.any(Uint8Array),
        }),
      ]),
    );

    // Verify Bob can unwrap the envelope
    const call = vi.mocked(storeKeyEnvelopes).mock.calls[0];
    const envelope = call[2][0].envelope;
    const unwrapped = await unwrapChannelKey(envelope, bob.secretKey);
    const originalKey = await getChannelKey('ch1', 1);
    expect(unwrapped).toEqual(originalKey);
  });

  it('does nothing if no key exists for channel', async () => {
    await distributeKeyToMember('ch1', 'bob', bob.publicKey);
    expect(storeKeyEnvelopes).not.toHaveBeenCalled();
  });
});

describe('rotateChannelKey', () => {
  it('generates new key, wraps for members, and calls rotate RPC', async () => {
    createChannelKey('ch1');

    const remaining = new Map<string, Uint8Array>([['alice', alice.publicKey]]);

    vi.mocked(rotateChannelKeyRpc).mockResolvedValue(2);

    const newVersion = await rotateChannelKey('ch1', remaining, 1);
    expect(newVersion).toBe(2);

    expect(rotateChannelKeyRpc).toHaveBeenCalledWith(
      'ch1',
      1,
      expect.arrayContaining([
        expect.objectContaining({
          userId: 'alice',
          envelope: expect.any(Uint8Array),
        }),
      ]),
    );

    // New key should be cached
    expect(getLatestKeyVersion('ch1')).toBe(2);
    const newKey = await getChannelKey('ch1', 2);
    expect(newKey.length).toBe(32);
  });
});

describe('getCachedChannelIds', () => {
  it('returns all cached channel IDs', () => {
    createChannelKey('ch1');
    createChannelKey('ch2');
    createChannelKey('ch3');

    const ids = getCachedChannelIds();
    expect(ids).toHaveLength(3);
    expect(ids).toContain('ch1');
    expect(ids).toContain('ch2');
    expect(ids).toContain('ch3');
  });

  it('returns empty array when no keys cached', () => {
    expect(getCachedChannelIds()).toEqual([]);
  });
});

describe('persistence', () => {
  it('schedules persist after createChannelKey', async () => {
    createChannelKey('ch1');

    // Flush to trigger persist
    await flushChannelKeys();

    expect(storeChannelKeys).toHaveBeenCalled();
  });

  it('loads cached keys from storage on bootstrap', async () => {
    // Create some keys and persist them
    createChannelKey('ch1');
    await flushChannelKeys();

    // Get the stored encrypted blob
    const storedCall = vi.mocked(storeChannelKeys).mock.calls[0];
    const encryptedKeys = storedCall[0];
    const iv = storedCall[1];

    // Clear cache and set up loadChannelKeys to return stored data
    clearChannelKeyCache();
    const masterKey = new Uint8Array(32);
    crypto.getRandomValues(masterKey);
    initChannelKeys(alice, masterKey);

    vi.mocked(loadChannelKeys).mockResolvedValue({ encryptedKeys, iv });

    // The keys won't decrypt since we used a different master key,
    // but the function should not throw
    await expect(loadCachedChannelKeys()).resolves.not.toThrow();
  });
});

describe('clearChannelKeyCache', () => {
  it('clears all cached keys', () => {
    createChannelKey('ch1');
    createChannelKey('ch2');
    expect(getCachedChannelIds()).toHaveLength(2);

    clearChannelKeyCache();
    expect(getCachedChannelIds()).toEqual([]);
    expect(hasChannelKey('ch1')).toBe(false);
  });
});

describe('key version isolation', () => {
  it('v1 key cannot decrypt v2 message', async () => {
    // Create a channel key (v1)
    const { key: keyV1 } = createChannelKey('ch-iso');

    // Encrypt with v1
    const plaintext = new TextEncoder().encode('version-1-message');
    const encrypted = await encryptPayload(keyV1, plaintext);

    // Generate a different key to simulate v2
    const keyV2 = generateChannelKey();

    // v2 key should not decrypt v1 message
    await expect(decryptPayload(keyV2, encrypted)).rejects.toThrow();
  });
});

describe('rapid sequential rotations', () => {
  it('handles 5 rotations in succession', async () => {
    createChannelKey('ch-rapid');

    // Mock 5 sequential rotations
    for (let i = 0; i < 5; i++) {
      const newVersion = i + 2;
      vi.mocked(rotateChannelKeyRpc).mockResolvedValueOnce(newVersion);

      const members = new Map<string, Uint8Array>();
      members.set('user-a', alice.publicKey);

      await rotateChannelKey('ch-rapid', members, i + 1);
    }

    // Should have called rotateChannelKeyRpc 5 times
    expect(rotateChannelKeyRpc).toHaveBeenCalledTimes(5);

    // Latest version should be 6
    expect(getLatestKeyVersion('ch-rapid')).toBe(6);
  });
});

describe('pre-initialization error paths', () => {
  // This nested describe does NOT call initChannelKeys in its beforeEach
  beforeEach(() => {
    vi.clearAllMocks();
    clearChannelKeyCache();
    // Intentionally NO initChannelKeys call — identity is null
  });

  it('fetchAndCacheChannelKeys throws "Channel keys not initialized" when identity is null', async () => {
    await expect(fetchAndCacheChannelKeys('ch1')).rejects.toThrow(
      'Channel keys not initialized',
    );
  });

  it('getChannelKey throws when identity is null and key not cached', async () => {
    await expect(getChannelKey('ch1', 1)).rejects.toThrow(
      'Channel keys not initialized',
    );
  });

  it('lazyInitChannelKey returns false when identity is null', async () => {
    const result = await lazyInitChannelKey('ch1', 'user-1');
    expect(result).toBe(false);
  });
});

describe('fetch deduplication', () => {
  it('coalesces concurrent fetches for same channel into single API call', async () => {
    const channelKey = generateChannelKey();
    const envelope = await wrapChannelKey(channelKey, alice.publicKey);

    vi.mocked(getKeyEnvelopes).mockResolvedValue([{ keyVersion: 1, envelope }]);

    // Fire two concurrent fetches for the same channel
    const [r1, r2] = await Promise.all([
      fetchAndCacheChannelKeys('ch1'),
      fetchAndCacheChannelKeys('ch1'),
    ]);

    // Both resolve but only one API call was made
    expect(r1).toBeUndefined();
    expect(r2).toBeUndefined();
    expect(getKeyEnvelopes).toHaveBeenCalledTimes(1);
  });

  it('allows new fetch after previous completes', async () => {
    const channelKey = generateChannelKey();
    const envelope = await wrapChannelKey(channelKey, alice.publicKey);

    vi.mocked(getKeyEnvelopes).mockResolvedValue([{ keyVersion: 1, envelope }]);

    await fetchAndCacheChannelKeys('ch1');
    expect(getKeyEnvelopes).toHaveBeenCalledTimes(1);

    await fetchAndCacheChannelKeys('ch1');
    expect(getKeyEnvelopes).toHaveBeenCalledTimes(2);
  });
});

describe('lazyInitChannelKey', () => {
  it('creates new key and stores self-envelope when no key exists', async () => {
    vi.mocked(rotateChannelKeyRpc).mockResolvedValue(1);
    vi.mocked(listMembersWithViewChannel).mockResolvedValue({
      members: [],
      nextCursor: '',
    });

    const result = await lazyInitChannelKey('ch-lazy', 'alice');

    expect(result).toBe(true);
    expect(rotateChannelKeyRpc).toHaveBeenCalledWith(
      'ch-lazy',
      0,
      expect.arrayContaining([
        expect.objectContaining({
          userId: 'alice',
          envelope: expect.any(Uint8Array),
        }),
      ]),
    );
    expect(hasChannelKey('ch-lazy')).toBe(true);
  });

  it('on version conflict, re-fetches the winner key', async () => {
    // rotateChannelKeyRpc throws (version conflict)
    vi.mocked(rotateChannelKeyRpc).mockRejectedValue(
      new Error('version conflict'),
    );

    // The re-fetch should return a valid key
    const winnerKey = generateChannelKey();
    const winnerEnvelope = await wrapChannelKey(winnerKey, alice.publicKey);
    vi.mocked(getKeyEnvelopes).mockResolvedValue([
      { keyVersion: 1, envelope: winnerEnvelope },
    ]);

    const result = await lazyInitChannelKey('ch-conflict', 'alice');

    expect(result).toBe(true);
    expect(getKeyEnvelopes).toHaveBeenCalledWith('ch-conflict');
    expect(hasChannelKey('ch-conflict')).toBe(true);
  });

  it('deduplicates concurrent lazy init calls', async () => {
    vi.mocked(rotateChannelKeyRpc).mockResolvedValue(1);
    vi.mocked(listMembersWithViewChannel).mockResolvedValue({
      members: [],
      nextCursor: '',
    });

    const [r1, r2] = await Promise.all([
      lazyInitChannelKey('ch-dedup', 'alice'),
      lazyInitChannelKey('ch-dedup', 'alice'),
    ]);

    // Both get the same result but RPC called only once
    expect(r1).toBe(true);
    expect(r2).toBe(true);
    expect(rotateChannelKeyRpc).toHaveBeenCalledTimes(1);
  });
});
