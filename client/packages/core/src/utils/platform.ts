/// <reference path="../types/electron.d.ts" />

export function isElectron(): boolean {
  return typeof window !== 'undefined' && 'electronAPI' in window;
}

export function isCapacitor(): boolean {
  if (typeof window === 'undefined') return false;
  const cap = (window as unknown as Record<string, unknown>).Capacitor;
  return (
    typeof cap === 'object' &&
    cap !== null &&
    typeof (cap as { isNativePlatform?: unknown }).isNativePlatform ===
      'function' &&
    (cap as { isNativePlatform: () => boolean }).isNativePlatform()
  );
}

export function getBaseUrl(): string {
  if (typeof window === 'undefined') return '';

  // Electron: injected by preload script
  if (window.__MEZA_BASE_URL__) {
    return window.__MEZA_BASE_URL__;
  }

  // Capacitor / subdomain deploy: set via VITE_API_URL at build time
  if (import.meta.env.VITE_API_URL) {
    return import.meta.env.VITE_API_URL;
  }

  // Web (same-origin): uses relative URLs
  return '';
}

/**
 * Normalize a URL string to its absolute origin (scheme + host + port).
 * Strips trailing slashes, query strings, and paths so that two helpers
 * built on top of this never disagree about what an "origin" is.
 */
function normalizeOrigin(rawUrl: string): string {
  try {
    return new URL(rawUrl).origin;
  } catch {
    return rawUrl.replace(/\/+$/, '');
  }
}

/**
 * Convert an API origin into a public-facing app origin.
 * Hosted Meza runs the SPA at `app.<domain>` and the API at `api.<domain>`;
 * when we only know the API URL we rewrite the `api.` prefix. The check
 * requires at least one additional label (`api.example.com`, not `api.com`)
 * to avoid mangling pathological hostnames. Self-hosters without that
 * convention fall through and reuse the URL as-is.
 */
function apiUrlToAppOrigin(apiUrl: string): string {
  const origin = normalizeOrigin(apiUrl);
  try {
    const url = new URL(origin);
    if (
      url.hostname.startsWith('api.') &&
      url.hostname.split('.').length >= 3
    ) {
      url.hostname = `app.${url.hostname.slice(4)}`;
      return url.origin;
    }
    return url.origin;
  } catch {
    return origin;
  }
}

/**
 * Returns the absolute API origin (e.g. https://api.meza.chat).
 * Used to build user-visible URLs that must hit the server — webhook
 * endpoints, OAuth callbacks, etc.
 */
export function getApiOrigin(): string {
  if (typeof window === 'undefined') return '';

  if (window.__MEZA_BASE_URL__) {
    return normalizeOrigin(window.__MEZA_BASE_URL__);
  }

  if (import.meta.env.VITE_API_URL) {
    return normalizeOrigin(import.meta.env.VITE_API_URL);
  }

  return window.location.origin;
}

/**
 * Returns the public-facing app origin for building shareable URLs (e.g.
 * invite links). Prefers an explicit `VITE_APP_URL`, otherwise derives the
 * app origin from the API URL via the hosted `api.` → `app.` convention.
 * Falls back to `window.location.origin` (correct for same-origin web).
 */
export function getAppOrigin(): string {
  if (typeof window === 'undefined') return '';

  if (import.meta.env.VITE_APP_URL) {
    return normalizeOrigin(import.meta.env.VITE_APP_URL);
  }

  if (window.__MEZA_BASE_URL__) {
    return apiUrlToAppOrigin(window.__MEZA_BASE_URL__);
  }

  if (import.meta.env.VITE_API_URL) {
    return apiUrlToAppOrigin(import.meta.env.VITE_API_URL);
  }

  return window.location.origin;
}
