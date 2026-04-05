import 'fake-indexeddb/auto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  cachePublicKey,
  clearVerification,
  getVerificationStatus,
  isVerificationValid,
  markVerified,
} from './key-monitor.ts';
import {
  _resetForTesting,
  clearCryptoStorage,
  loadCachedKey,
} from './storage.ts';

const ALICE_SECRET = new Uint8Array(32).fill(0x01);
const ALICE_PUBLIC = ed25519.getPublicKey(ALICE_SECRET);
const BOB_SECRET = new Uint8Array(32).fill(0x02);
const BOB_PUBLIC = ed25519.getPublicKey(BOB_SECRET);

const USER_A = '01HZXK5M8E3J6Q9P2RVTYWN4AB';
const USER_B = '01HZXK5M8E3J6Q9P2RVTYWN4CD';

beforeEach(async () => {
  _resetForTesting();
  const req = indexedDB.deleteDatabase('meza-crypto');
  await new Promise<void>((resolve, reject) => {
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
});

describe('cachePublicKey', () => {
  it('returns first-seen for a new user', async () => {
    const result = await cachePublicKey(USER_A, ALICE_PUBLIC);
    expect(result).toBe('first-seen');
  });

  it('returns unchanged for the same key', async () => {
    await cachePublicKey(USER_A, ALICE_PUBLIC);
    const result = await cachePublicKey(USER_A, ALICE_PUBLIC);
    expect(result).toBe('unchanged');
  });

  it('returns changed when the key differs', async () => {
    await cachePublicKey(USER_A, ALICE_PUBLIC);
    const result = await cachePublicKey(USER_A, BOB_PUBLIC);
    expect(result).toBe('changed');
  });

  it('updates the cached key on change', async () => {
    await cachePublicKey(USER_A, ALICE_PUBLIC);
    await cachePublicKey(USER_A, BOB_PUBLIC);
    const cached = await loadCachedKey(USER_A);
    expect(cached?.publicKey).toEqual(BOB_PUBLIC);
  });

  it('preserves firstSeenAt on key change', async () => {
    await cachePublicKey(USER_A, ALICE_PUBLIC);
    const first = await loadCachedKey(USER_A);
    await cachePublicKey(USER_A, BOB_PUBLIC);
    const second = await loadCachedKey(USER_A);
    expect(second?.firstSeenAt).toBe(first?.firstSeenAt);
  });
});

describe('markVerified / getVerificationStatus', () => {
  it('stores and retrieves verification status', async () => {
    await markVerified(USER_A, ALICE_PUBLIC);
    const status = await getVerificationStatus(USER_A);
    expect(status).not.toBeNull();
    expect(status?.verified).toBe(true);
    expect(status?.verifiedAt).toBeGreaterThan(0);
  });

  it('returns null for unverified users', async () => {
    const status = await getVerificationStatus(USER_A);
    expect(status).toBeNull();
  });
});

describe('clearVerification', () => {
  it('removes verification status', async () => {
    await markVerified(USER_A, ALICE_PUBLIC);
    await clearVerification(USER_A);
    const status = await getVerificationStatus(USER_A);
    expect(status).toBeNull();
  });

  it('is idempotent', async () => {
    await expect(clearVerification(USER_A)).resolves.not.toThrow();
  });
});

describe('isVerificationValid', () => {
  it('returns true when key matches stored hash', async () => {
    await markVerified(USER_A, ALICE_PUBLIC);
    const valid = await isVerificationValid(USER_A, ALICE_PUBLIC);
    expect(valid).toBe(true);
  });

  it('returns false when key differs from stored hash', async () => {
    await markVerified(USER_A, ALICE_PUBLIC);
    const valid = await isVerificationValid(USER_A, BOB_PUBLIC);
    expect(valid).toBe(false);
  });

  it('returns false when no verification exists', async () => {
    const valid = await isVerificationValid(USER_A, ALICE_PUBLIC);
    expect(valid).toBe(false);
  });
});

describe('clearCryptoStorage clears new stores', () => {
  it('clears cached keys and verifications on logout', async () => {
    await cachePublicKey(USER_A, ALICE_PUBLIC);
    await markVerified(USER_A, ALICE_PUBLIC);

    await clearCryptoStorage();

    const cached = await loadCachedKey(USER_A);
    const status = await getVerificationStatus(USER_A);
    expect(cached).toBeNull();
    expect(status).toBeNull();
  });
});
