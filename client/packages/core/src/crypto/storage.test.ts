import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  _resetForTesting,
  clearCryptoStorage,
  loadChannelKeys,
  loadKeyBundle,
  storeChannelKeys,
  storeKeyBundle,
} from './storage.ts';

beforeEach(async () => {
  _resetForTesting();
  // Delete the database between tests for full isolation
  const req = indexedDB.deleteDatabase('meza-crypto');
  await new Promise<void>((resolve, reject) => {
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
});

describe('storeKeyBundle / loadKeyBundle', () => {
  it('roundtrips a key bundle', async () => {
    const bundle = crypto.getRandomValues(new Uint8Array(92));

    await storeKeyBundle(bundle);
    const loaded = await loadKeyBundle();

    expect(loaded).not.toBeNull();
    expect(loaded).toEqual(bundle);
  });

  it('loadKeyBundle returns null when empty', async () => {
    const loaded = await loadKeyBundle();
    expect(loaded).toBeNull();
  });

  it('overwrites existing key bundle on re-store', async () => {
    const bundle1 = crypto.getRandomValues(new Uint8Array(92));
    const bundle2 = crypto.getRandomValues(new Uint8Array(92));

    await storeKeyBundle(bundle1);
    await storeKeyBundle(bundle2);
    const loaded = await loadKeyBundle();

    expect(loaded).toEqual(bundle2);
    expect(loaded).not.toEqual(bundle1);
  });
});

describe('storeChannelKeys / loadChannelKeys', () => {
  it('roundtrips channel keys', async () => {
    const encryptedKeys = crypto.getRandomValues(new Uint8Array(256));
    const iv = crypto.getRandomValues(new Uint8Array(12));

    await storeChannelKeys(encryptedKeys, iv);
    const loaded = await loadChannelKeys();

    expect(loaded).not.toBeNull();
    expect(loaded?.encryptedKeys).toEqual(encryptedKeys);
    expect(loaded?.iv).toEqual(iv);
  });

  it('loadChannelKeys returns null when empty', async () => {
    const loaded = await loadChannelKeys();
    expect(loaded).toBeNull();
  });

  it('overwrites existing channel keys on re-store', async () => {
    const keys1 = crypto.getRandomValues(new Uint8Array(128));
    const iv1 = crypto.getRandomValues(new Uint8Array(12));
    const keys2 = crypto.getRandomValues(new Uint8Array(256));
    const iv2 = crypto.getRandomValues(new Uint8Array(12));

    await storeChannelKeys(keys1, iv1);
    await storeChannelKeys(keys2, iv2);
    const loaded = await loadChannelKeys();

    expect(loaded?.encryptedKeys).toEqual(keys2);
    expect(loaded?.iv).toEqual(iv2);
  });
});

describe('clearCryptoStorage', () => {
  it('clears key bundle after storing', async () => {
    const bundle = crypto.getRandomValues(new Uint8Array(92));
    await storeKeyBundle(bundle);

    await clearCryptoStorage();

    const loaded = await loadKeyBundle();
    expect(loaded).toBeNull();
  });

  it('clears channel keys after storing', async () => {
    const encryptedKeys = crypto.getRandomValues(new Uint8Array(256));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    await storeChannelKeys(encryptedKeys, iv);

    await clearCryptoStorage();

    const loaded = await loadChannelKeys();
    expect(loaded).toBeNull();
  });

  it('clears both stores at once', async () => {
    const bundle = crypto.getRandomValues(new Uint8Array(92));
    const encryptedKeys = crypto.getRandomValues(new Uint8Array(256));
    const iv = crypto.getRandomValues(new Uint8Array(12));

    await storeKeyBundle(bundle);
    await storeChannelKeys(encryptedKeys, iv);

    await clearCryptoStorage();

    expect(await loadKeyBundle()).toBeNull();
    expect(await loadChannelKeys()).toBeNull();
  });

  it('is idempotent (clearing empty storage does not throw)', async () => {
    await expect(clearCryptoStorage()).resolves.not.toThrow();
  });
});

describe('database version', () => {
  it('opens with version 4 and creates expected stores', async () => {
    // Trigger DB creation by performing any operation
    await storeKeyBundle(crypto.getRandomValues(new Uint8Array(32)));

    // Verify by opening the DB directly and checking its properties
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('meza-crypto');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });

    expect(db.version).toBe(4);
    expect(db.objectStoreNames.contains('key-bundle')).toBe(true);
    expect(db.objectStoreNames.contains('channel-keys')).toBe(true);
    db.close();
  });
});
