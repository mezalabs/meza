/// <reference path="../types/electron.d.ts" />

export function isElectron(): boolean {
  return typeof window !== 'undefined' && 'electronAPI' in window;
}

export function getBaseUrl(): string {
  if (typeof window !== 'undefined' && window.__MEZA_BASE_URL__) {
    return window.__MEZA_BASE_URL__;
  }
  return '';
}
