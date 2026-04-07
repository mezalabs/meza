import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getApiOrigin, getAppOrigin } from './platform.ts';

// The core package runs vitest in a node environment, so we install a
// minimal `window` shim before each test instead of relying on jsdom.
type WindowShim = {
  __MEZA_BASE_URL__?: string;
  location: { origin: string };
};

beforeEach(() => {
  const shim: WindowShim = { location: { origin: 'https://app.meza.chat' } };
  vi.stubGlobal('window', shim);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('getApiOrigin', () => {
  it('returns __MEZA_BASE_URL__ origin (Electron)', () => {
    (globalThis.window as WindowShim).__MEZA_BASE_URL__ =
      'https://api.meza.chat/';
    expect(getApiOrigin()).toBe('https://api.meza.chat');
  });

  it('returns VITE_API_URL origin (Capacitor)', () => {
    vi.stubEnv('VITE_API_URL', 'https://api.meza.chat');
    expect(getApiOrigin()).toBe('https://api.meza.chat');
  });

  it('strips trailing paths from VITE_API_URL', () => {
    vi.stubEnv('VITE_API_URL', 'https://api.example.com/v1/');
    expect(getApiOrigin()).toBe('https://api.example.com');
  });

  it('falls back to window.location.origin (web)', () => {
    expect(getApiOrigin()).toBe('https://app.meza.chat');
  });
});

describe('getAppOrigin', () => {
  it('prefers VITE_APP_URL when set', () => {
    vi.stubEnv('VITE_APP_URL', 'https://app.meza.chat');
    vi.stubEnv('VITE_API_URL', 'https://api.meza.chat');
    expect(getAppOrigin()).toBe('https://app.meza.chat');
  });

  it('rewrites api.<domain> to app.<domain> in __MEZA_BASE_URL__', () => {
    (globalThis.window as WindowShim).__MEZA_BASE_URL__ =
      'https://api.meza.chat';
    expect(getAppOrigin()).toBe('https://app.meza.chat');
  });

  it('rewrites api.<domain> to app.<domain> in VITE_API_URL', () => {
    vi.stubEnv('VITE_API_URL', 'https://api.staging.meza.chat');
    expect(getAppOrigin()).toBe('https://app.staging.meza.chat');
  });

  it('preserves the port when rewriting', () => {
    vi.stubEnv('VITE_API_URL', 'https://api.meza.chat:8443');
    expect(getAppOrigin()).toBe('https://app.meza.chat:8443');
  });

  it('does not mangle a 2-label hostname like api.localhost', () => {
    vi.stubEnv('VITE_API_URL', 'https://api.localhost');
    expect(getAppOrigin()).toBe('https://api.localhost');
  });

  it('does not rewrite a non-api hostname', () => {
    vi.stubEnv('VITE_API_URL', 'https://chat.example.com');
    expect(getAppOrigin()).toBe('https://chat.example.com');
  });

  it('falls back to window.location.origin in web with no env set', () => {
    expect(getAppOrigin()).toBe('https://app.meza.chat');
  });
});
