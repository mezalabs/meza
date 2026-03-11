/// <reference path="../types/electron.d.ts" />
/// <reference types="vite/client" />

export function isElectron(): boolean {
  return typeof window !== 'undefined' && 'electronAPI' in window;
}

export function isCapacitor(): boolean {
  if (typeof window === 'undefined') return false;
  const cap = (window as unknown as Record<string, unknown>).Capacitor;
  return (
    typeof cap === 'object' &&
    cap !== null &&
    typeof (cap as { isNativePlatform?: unknown }).isNativePlatform === 'function' &&
    (cap as { isNativePlatform: () => boolean }).isNativePlatform()
  );
}

export function getBaseUrl(): string {
  if (typeof window === 'undefined') return '';

  // Electron: injected by preload script
  if (window.__MEZA_BASE_URL__) {
    return window.__MEZA_BASE_URL__;
  }

  // Capacitor: set via VITE_API_URL at build time
  if (isCapacitor() && import.meta.env.VITE_API_URL) {
    return import.meta.env.VITE_API_URL;
  }

  // Web: uses relative URLs (same origin)
  return '';
}
