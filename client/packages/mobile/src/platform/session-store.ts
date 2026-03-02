/**
 * Session store: replaces sessionStorage with an in-memory Map.
 *
 * On web, sessionStorage survives page reload but clears on tab close.
 * On mobile, we use an in-memory Map that clears when the app is killed.
 *
 * The master key is stored here during an active session and cleared
 * when the app goes to background (via AppState listener in the root layout).
 *
 * If biometric lock is enabled, the master key is also persisted to
 * expo-secure-store for quick restore on app resume.
 */

const store = new Map<string, string>();

/**
 * Polyfill for sessionStorage that works in React Native.
 * Drop-in replacement — same API surface.
 */
export const sessionStore = {
  getItem(key: string): string | null {
    return store.get(key) ?? null;
  },

  setItem(key: string, value: string): void {
    store.set(key, value);
  },

  removeItem(key: string): void {
    store.delete(key);
  },

  clear(): void {
    store.clear();
  },
};
