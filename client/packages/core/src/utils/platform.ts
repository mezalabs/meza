/// <reference path="../types/electron.d.ts" />

export function isElectron(): boolean {
  return typeof window !== 'undefined' && 'electronAPI' in window;
}

export function isCapacitor(): boolean {
  return (
    typeof window !== 'undefined' &&
    'Capacitor' in window &&
    typeof (window as Record<string, unknown>).Capacitor === 'object' &&
    typeof ((window as Record<string, unknown>).Capacitor as Record<string, unknown>)?.isNativePlatform === 'function' &&
    ((window as Record<string, unknown>).Capacitor as { isNativePlatform: () => boolean }).isNativePlatform()
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
