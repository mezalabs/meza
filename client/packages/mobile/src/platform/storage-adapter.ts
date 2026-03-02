/**
 * Storage adapter: replaces IndexedDB with MMKV for React Native.
 *
 * Provides the same interface as @meza/core's crypto/storage.ts
 * (storeKeyBundle, loadKeyBundle, storeChannelKeys, loadChannelKeys, etc.)
 * but backed by react-native-mmkv with encrypted storage.
 *
 * This module is NOT a polyfill for IndexedDB — instead, @meza/core's
 * storage.ts needs to be updated to support a pluggable backend.
 * For Phase 1, this provides the MMKV primitives that will be wired in.
 */
import { MMKV } from 'react-native-mmkv';

const SCHEMA_VERSION = 1;
const KEY_SCHEMA_VERSION = '_schema_version';
const KEY_KEY_BUNDLE = 'key-bundle';
const KEY_CHANNEL_KEYS = 'channel-keys';
const KEY_CHANNEL_KEYS_IV = 'channel-keys-iv';
const KEY_SESSION_ID = 'gateway-session-id';
const KEY_LAST_SEQUENCE = 'gateway-last-sequence';

/**
 * MMKV instance for crypto storage.
 * Uses default (unencrypted) MMKV for now — the data stored here is already
 * encrypted with the user's master key (AES-256-GCM), so double encryption
 * is unnecessary. The master key itself lives in expo-secure-store.
 */
export const storage = new MMKV({ id: 'meza-crypto' });

// --- Schema Migration ---

function runMigrations(): void {
  const current = storage.getNumber(KEY_SCHEMA_VERSION) ?? 0;
  if (current >= SCHEMA_VERSION) return;

  // v0 → v1: initial schema, nothing to migrate
  storage.set(KEY_SCHEMA_VERSION, SCHEMA_VERSION);
}

// Run migrations on module load
runMigrations();

// --- Key Bundle (Ed25519 Identity Keypair) ---

export function storeKeyBundle(keyBundle: Uint8Array): void {
  storage.set(KEY_KEY_BUNDLE, keyBundle.buffer as ArrayBuffer);
}

export function loadKeyBundle(): Uint8Array | null {
  const buffer = storage.getBuffer(KEY_KEY_BUNDLE);
  if (!buffer) return null;
  return new Uint8Array(buffer);
}

// --- Channel Keys (blob-encrypted map) ---

export function storeChannelKeys(
  encryptedKeys: Uint8Array,
  iv: Uint8Array,
): void {
  storage.set(KEY_CHANNEL_KEYS, encryptedKeys.buffer as ArrayBuffer);
  storage.set(KEY_CHANNEL_KEYS_IV, iv.buffer as ArrayBuffer);
}

export function loadChannelKeys(): {
  encryptedKeys: Uint8Array;
  iv: Uint8Array;
} | null {
  const keysBuffer = storage.getBuffer(KEY_CHANNEL_KEYS);
  const ivBuffer = storage.getBuffer(KEY_CHANNEL_KEYS_IV);
  if (!keysBuffer || !ivBuffer) return null;
  return {
    encryptedKeys: new Uint8Array(keysBuffer),
    iv: new Uint8Array(ivBuffer),
  };
}

// --- Gateway Session Persistence ---

export function storeGatewaySession(
  sessionId: string,
  lastSequence: number,
): void {
  storage.set(KEY_SESSION_ID, sessionId);
  storage.set(KEY_LAST_SEQUENCE, lastSequence);
}

export function loadGatewaySession(): {
  sessionId: string;
  lastSequence: number;
} | null {
  const sessionId = storage.getString(KEY_SESSION_ID);
  const lastSequence = storage.getNumber(KEY_LAST_SEQUENCE);
  if (!sessionId || lastSequence === undefined) return null;
  return { sessionId, lastSequence };
}

// --- Clear ---

export function clearCryptoStorage(): void {
  storage.delete(KEY_KEY_BUNDLE);
  storage.delete(KEY_CHANNEL_KEYS);
  storage.delete(KEY_CHANNEL_KEYS_IV);
  storage.delete(KEY_SESSION_ID);
  storage.delete(KEY_LAST_SEQUENCE);
}
