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
 * Returns the public-facing origin for building shareable URLs (e.g. invite links).
 * On Capacitor/Electron, window.location.origin is a local address (https://localhost),
 * so we use the configured server URL instead.
 */
export function getAppOrigin(): string {
  if (typeof window === 'undefined') return '';

  if (window.__MEZA_BASE_URL__) {
    return window.__MEZA_BASE_URL__.replace(/\/+$/, '');
  }

  if (import.meta.env.VITE_API_URL) {
    return import.meta.env.VITE_API_URL.replace(/\/+$/, '');
  }

  return window.location.origin;
}
