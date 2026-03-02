/**
 * Configure the base URL for API requests on mobile.
 *
 * packages/core's getBaseUrl() checks window.__MEZA_BASE_URL__ first.
 * On web this is empty (relative URLs), but on mobile we need an absolute URL
 * since there's no hosting domain.
 *
 * TODO: Make this configurable via Expo Constants or a settings screen.
 */

import Constants from 'expo-constants';

const DEFAULT_BASE_URL = 'https://meza.chat';

// Read from Expo config extra or fallback to default
const baseUrl =
  (Constants.expoConfig?.extra?.apiBaseUrl as string) ?? DEFAULT_BASE_URL;

// Set the global that core's getBaseUrl() reads
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const g = globalThis as any;
if (typeof g.window === 'undefined') {
  g.window = {};
}
g.window.__MEZA_BASE_URL__ = baseUrl;
