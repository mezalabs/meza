/**
 * IndexedDB persistence for E2EE crypto state.
 *
 * Stores:
 * - key-bundle: Encrypted Ed25519 identity keypair
 * - channel-keys: Encrypted channel key cache (blob-encrypted map)
 *
 * v4 replaces the MLS-era provider-state and mls-groups stores.
 * Uses a singleton connection to avoid open/close churn on every operation.
 */

const DB_NAME = 'meza-crypto';
const DB_VERSION = 5;
const STORE_KEY_BUNDLE = 'key-bundle';
const STORE_CHANNEL_KEYS = 'channel-keys';
const STORE_CACHED_KEYS = 'cached-keys';
const STORE_VERIFICATION = 'verification';

interface KeyBundleRecord {
  id: 'current';
  keyBundle: Uint8Array;
}

interface ChannelKeysRecord {
  id: 'current';
  encryptedKeys: Uint8Array;
  iv: Uint8Array;
}

export interface CachedKeyRecord {
  userId: string;
  publicKey: Uint8Array;
  firstSeenAt: number;
}

export interface VerificationRecord {
  userId: string;
  verified: boolean;
  /** SHA-256 hex digest of the public key at verification time. */
  publicKeyHash: string;
  verifiedAt: number;
}

/** Singleton DB connection, reused across all operations. */
let dbInstance: IDBDatabase | null = null;
let dbPromise: Promise<IDBDatabase> | null = null;

function getDB(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(
      new Error('indexedDB is not available in this environment'),
    );
  }
  if (dbInstance) return Promise.resolve(dbInstance);
  if (dbPromise) return dbPromise;

  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const db = request.result;
      const oldVersion = event.oldVersion;

      // Create key-bundle store if it doesn't exist (present since v1)
      if (!db.objectStoreNames.contains(STORE_KEY_BUNDLE)) {
        db.createObjectStore(STORE_KEY_BUNDLE, { keyPath: 'id' });
      }

      // Create channel-keys store (new in v4)
      if (!db.objectStoreNames.contains(STORE_CHANNEL_KEYS)) {
        db.createObjectStore(STORE_CHANNEL_KEYS, { keyPath: 'id' });
      }

      // Create cached-keys store for key change detection (new in v5)
      if (!db.objectStoreNames.contains(STORE_CACHED_KEYS)) {
        db.createObjectStore(STORE_CACHED_KEYS, { keyPath: 'userId' });
      }

      // Create verification store for safety number status (new in v5)
      if (!db.objectStoreNames.contains(STORE_VERIFICATION)) {
        db.createObjectStore(STORE_VERIFICATION, { keyPath: 'userId' });
      }

      // Remove MLS-era stores on upgrade from v3 or earlier
      if (oldVersion < 4) {
        for (const storeName of ['provider-state', 'mls-groups']) {
          if (db.objectStoreNames.contains(storeName)) {
            db.deleteObjectStore(storeName);
          }
        }
      }
    };
    request.onsuccess = () => {
      dbInstance = request.result;
      // Reset singleton if the connection is unexpectedly closed.
      dbInstance.onclose = () => {
        dbInstance = null;
        dbPromise = null;
      };
      resolve(dbInstance);
    };
    request.onerror = () => {
      dbPromise = null;
      reject(request.error);
    };
  });

  return dbPromise;
}

// --- Key Bundle (Ed25519 Identity Keypair) ---

/**
 * Store the encrypted identity keypair in IndexedDB.
 * Format: [12 bytes IV][ciphertext] — encrypted with master key via AES-256-GCM.
 */
export async function storeKeyBundle(keyBundle: Uint8Array): Promise<void> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_KEY_BUNDLE, 'readwrite');
    const store = tx.objectStore(STORE_KEY_BUNDLE);
    const record: KeyBundleRecord = { id: 'current', keyBundle };
    store.put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('Transaction aborted'));
  });
}

/**
 * Retrieve the encrypted identity keypair from IndexedDB.
 * Returns null if no identity is stored.
 */
export async function loadKeyBundle(): Promise<Uint8Array | null> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_KEY_BUNDLE, 'readonly');
    const store = tx.objectStore(STORE_KEY_BUNDLE);
    const req = store.get('current');
    tx.oncomplete = () => {
      const record = req.result as KeyBundleRecord | undefined;
      resolve(record?.keyBundle ?? null);
    };
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('Transaction aborted'));
  });
}

// --- Channel Keys (blob-encrypted map) ---

/**
 * Store the encrypted channel keys blob in IndexedDB.
 */
export async function storeChannelKeys(
  encryptedKeys: Uint8Array,
  iv: Uint8Array,
): Promise<void> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_CHANNEL_KEYS, 'readwrite');
    const store = tx.objectStore(STORE_CHANNEL_KEYS);
    const record: ChannelKeysRecord = { id: 'current', encryptedKeys, iv };
    store.put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('Transaction aborted'));
  });
}

/**
 * Load the encrypted channel keys blob from IndexedDB.
 */
export async function loadChannelKeys(): Promise<{
  encryptedKeys: Uint8Array;
  iv: Uint8Array;
} | null> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_CHANNEL_KEYS, 'readonly');
    const store = tx.objectStore(STORE_CHANNEL_KEYS);
    const req = store.get('current');
    tx.oncomplete = () => {
      const record = req.result as ChannelKeysRecord | undefined;
      if (record) {
        resolve({
          encryptedKeys: record.encryptedKeys,
          iv: record.iv,
        });
      } else {
        resolve(null);
      }
    };
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('Transaction aborted'));
  });
}

// --- Cached Public Keys (key change detection) ---

/**
 * Read a cached public key record for a user.
 */
export async function loadCachedKey(
  userId: string,
): Promise<CachedKeyRecord | null> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_CACHED_KEYS, 'readonly');
    const req = tx.objectStore(STORE_CACHED_KEYS).get(userId);
    tx.oncomplete = () => resolve((req.result as CachedKeyRecord) ?? null);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('Transaction aborted'));
  });
}

/**
 * Store or update a cached public key record.
 */
export async function storeCachedKey(record: CachedKeyRecord): Promise<void> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_CACHED_KEYS, 'readwrite');
    tx.objectStore(STORE_CACHED_KEYS).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('Transaction aborted'));
  });
}

// --- Verification Status (safety numbers) ---

/**
 * Read the verification status for a user.
 */
export async function loadVerification(
  userId: string,
): Promise<VerificationRecord | null> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_VERIFICATION, 'readonly');
    const req = tx.objectStore(STORE_VERIFICATION).get(userId);
    tx.oncomplete = () => resolve((req.result as VerificationRecord) ?? null);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('Transaction aborted'));
  });
}

/**
 * Store or update the verification status for a user.
 */
export async function storeVerification(
  record: VerificationRecord,
): Promise<void> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_VERIFICATION, 'readwrite');
    tx.objectStore(STORE_VERIFICATION).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('Transaction aborted'));
  });
}

/**
 * Remove verification status for a user.
 */
export async function deleteVerification(userId: string): Promise<void> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_VERIFICATION, 'readwrite');
    tx.objectStore(STORE_VERIFICATION).delete(userId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('Transaction aborted'));
  });
}

/**
 * Load all verification records (for hydrating the verification store).
 */
export async function loadAllVerifications(): Promise<VerificationRecord[]> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_VERIFICATION, 'readonly');
    const req = tx.objectStore(STORE_VERIFICATION).getAll();
    tx.oncomplete = () => resolve((req.result as VerificationRecord[]) ?? []);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('Transaction aborted'));
  });
}

// --- Testing ---

/**
 * Reset the singleton DB connection for test isolation.
 * Only call this from test code.
 */
export function _resetForTesting(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
  dbPromise = null;
}

/**
 * Clear only the channel keys blob from IndexedDB (e.g. stale cache after key change).
 */
export async function clearChannelKeysStorage(): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_CHANNEL_KEYS, 'readwrite');
    tx.objectStore(STORE_CHANNEL_KEYS).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('Transaction aborted'));
  });
}

// --- Clear ---

/**
 * Clear all crypto state from IndexedDB (used on logout).
 */
export async function clearCryptoStorage(): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const stores = [
      STORE_KEY_BUNDLE,
      STORE_CHANNEL_KEYS,
      STORE_CACHED_KEYS,
      STORE_VERIFICATION,
    ];
    const tx = db.transaction(stores, 'readwrite');
    for (const name of stores) {
      tx.objectStore(name).clear();
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('Transaction aborted'));
  });
}
