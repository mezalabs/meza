import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoredUser } from './auth.ts';
import { useAuthStore } from './auth.ts';

const mockUser: StoredUser = {
  id: '1',
  username: 'alice',
  displayName: 'Alice',
  avatarUrl: 'https://example.com/alice.png',
  emojiScale: 1,
  bio: '',
  pronouns: '',
  bannerUrl: '',
  themeColorPrimary: '',
  themeColorSecondary: '',
  simpleMode: false,
  dmPrivacy: 'message_requests',
  friendRequestPrivacy: 'everyone',
  profilePrivacy: 'everyone',
  connections: [],
  createdAt: '',
};

const mockStorage = new Map<string, string>();

beforeEach(() => {
  mockStorage.clear();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => mockStorage.get(key) ?? null,
    setItem: (key: string, value: string) => mockStorage.set(key, value),
    removeItem: (key: string) => mockStorage.delete(key),
  });
  useAuthStore.setState({
    accessToken: null,
    refreshToken: null,
    user: null,
    isAuthenticated: false,
    isLoading: false,
    error: null,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('auth store', () => {
  it('starts unauthenticated', () => {
    const state = useAuthStore.getState();
    expect(state.isAuthenticated).toBe(false);
    expect(state.accessToken).toBeNull();
    expect(state.user).toBeNull();
  });

  it('setAuth stores tokens and user', () => {
    useAuthStore.getState().setAuth('access-123', 'refresh-456', mockUser);
    const state = useAuthStore.getState();

    expect(state.accessToken).toBe('access-123');
    expect(state.refreshToken).toBe('refresh-456');
    expect(state.user).toEqual(mockUser);
    expect(state.isAuthenticated).toBe(true);
    expect(state.error).toBeNull();
  });

  it('setAuth persists to localStorage', () => {
    useAuthStore.getState().setAuth('access-123', 'refresh-456', mockUser);

    expect(mockStorage.get('meza:access_token')).toBe('access-123');
    expect(mockStorage.get('meza:refresh_token')).toBe('refresh-456');
    // biome-ignore lint/style/noNonNullAssertion: guarded by prior assertions
    expect(JSON.parse(mockStorage.get('meza:user')!)).toEqual(mockUser);
  });

  it('setTokens updates tokens without clearing user', () => {
    useAuthStore.getState().setAuth('old-access', 'old-refresh', mockUser);
    useAuthStore.getState().setTokens('new-access', 'new-refresh');

    const state = useAuthStore.getState();
    expect(state.accessToken).toBe('new-access');
    expect(state.refreshToken).toBe('new-refresh');
    expect(state.user).toEqual(mockUser);
  });

  it('clearAuth removes everything', () => {
    useAuthStore.getState().setAuth('access-123', 'refresh-456', mockUser);
    useAuthStore.getState().clearAuth();

    const state = useAuthStore.getState();
    expect(state.accessToken).toBeNull();
    expect(state.refreshToken).toBeNull();
    expect(state.user).toBeNull();
    expect(state.isAuthenticated).toBe(false);
    expect(mockStorage.size).toBe(0);
  });

  it('setLoading updates loading state', () => {
    useAuthStore.getState().setLoading(true);
    expect(useAuthStore.getState().isLoading).toBe(true);

    useAuthStore.getState().setLoading(false);
    expect(useAuthStore.getState().isLoading).toBe(false);
  });

  it('setError sets error and clears loading', () => {
    useAuthStore.getState().setLoading(true);
    useAuthStore.getState().setError('Something failed');

    const state = useAuthStore.getState();
    expect(state.error).toBe('Something failed');
    expect(state.isLoading).toBe(false);
  });

  it('setError with null clears error', () => {
    useAuthStore.getState().setError('old error');
    useAuthStore.getState().setError(null);

    expect(useAuthStore.getState().error).toBeNull();
  });
});
