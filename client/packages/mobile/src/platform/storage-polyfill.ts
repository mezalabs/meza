/**
 * localStorage + sessionStorage polyfills for React Native.
 *
 * Provides a synchronous key-value API backed by react-native-mmkv so that
 * packages/core's auth store (which uses localStorage directly) works on mobile.
 *
 * MUST be imported before any @meza/core imports in app/_layout.tsx.
 */

import { MMKV } from 'react-native-mmkv';

const localMmkv = new MMKV({ id: 'meza-localstorage' });
const sessionMmkv = new MMKV({ id: 'meza-sessionstorage' });

function createStoragePolyfill(mmkv: MMKV): Storage {
  return {
    getItem(key: string): string | null {
      return mmkv.getString(key) ?? null;
    },
    setItem(key: string, value: string): void {
      mmkv.set(key, value);
    },
    removeItem(key: string): void {
      mmkv.delete(key);
    },
    clear(): void {
      mmkv.clearAll();
    },
    get length(): number {
      return mmkv.getAllKeys().length;
    },
    key(index: number): string | null {
      return mmkv.getAllKeys()[index] ?? null;
    },
  };
}

// Install globals if not already present (i.e., not running in a browser)
if (typeof globalThis.localStorage === 'undefined') {
  (globalThis as Record<string, unknown>).localStorage =
    createStoragePolyfill(localMmkv);
}

if (typeof globalThis.sessionStorage === 'undefined') {
  (globalThis as Record<string, unknown>).sessionStorage =
    createStoragePolyfill(sessionMmkv);
}
