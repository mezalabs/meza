import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

const ACCESS_TOKEN_KEY = 'meza:access_token';
const REFRESH_TOKEN_KEY = 'meza:refresh_token';
const USER_KEY = 'meza:user';

/** Known social platform identifiers, matching the proto comment on UserConnection.platform. */
export type ConnectionPlatform =
  | 'github'
  | 'twitter'
  | 'twitch'
  | 'youtube'
  | 'linkedin'
  | 'website'
  | 'steam'
  | 'spotify'
  | 'reddit'
  | 'other';

/** Display labels for each platform. */
export const PLATFORM_LABELS: Record<ConnectionPlatform, string> = {
  github: 'GitHub',
  twitter: 'Twitter',
  twitch: 'Twitch',
  youtube: 'YouTube',
  linkedin: 'LinkedIn',
  website: 'Website',
  steam: 'Steam',
  spotify: 'Spotify',
  reddit: 'Reddit',
  other: 'Other',
};

/**
 * Plain serializable subset of the proto User — avoids storing protobuf
 * Message instances in localStorage (they don't survive JSON round-trips).
 */
export interface StoredUserConnection {
  platform: ConnectionPlatform;
  url: string;
  label: string;
}

export interface StoredUser {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string;
  emojiScale: number;
  bio: string;
  pronouns: string;
  bannerUrl: string;
  themeColorPrimary: string;
  themeColorSecondary: string;
  simpleMode: boolean;
  dmPrivacy: string;
  connections: StoredUserConnection[];
  createdAt: string;
  isBot?: boolean;
}

export interface AuthState {
  accessToken: string | null;
  refreshToken: string | null;
  user: StoredUser | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;
}

export interface AuthActions {
  setAuth: (
    accessToken: string,
    refreshToken: string,
    user: StoredUser,
  ) => void;
  setTokens: (accessToken: string, refreshToken: string) => void;
  updateUser: (
    updates: Partial<
      Pick<
        StoredUser,
        | 'displayName'
        | 'avatarUrl'
        | 'emojiScale'
        | 'bio'
        | 'pronouns'
        | 'bannerUrl'
        | 'themeColorPrimary'
        | 'themeColorSecondary'
        | 'simpleMode'
        | 'dmPrivacy'
        | 'connections'
      >
    >,
  ) => void;
  clearAuth: () => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
}

function loadFromStorage(): Partial<AuthState> {
  try {
    const accessToken = localStorage.getItem(ACCESS_TOKEN_KEY);
    const refreshToken = localStorage.getItem(REFRESH_TOKEN_KEY);
    const userJson = localStorage.getItem(USER_KEY);
    const user: StoredUser | null = userJson ? JSON.parse(userJson) : null;
    return {
      accessToken,
      refreshToken,
      user,
      isAuthenticated: !!accessToken,
    };
  } catch {
    // SSR, test environments, or corrupt storage
    return {};
  }
}

export const useAuthStore = create<AuthState & AuthActions>()(
  immer((set) => ({
    accessToken: null,
    refreshToken: null,
    user: null,
    isAuthenticated: false,
    isLoading: false,
    error: null,
    ...loadFromStorage(),

    setAuth: (accessToken, refreshToken, user) => {
      localStorage.setItem(ACCESS_TOKEN_KEY, accessToken);
      localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
      localStorage.setItem(USER_KEY, JSON.stringify(user));
      set((state) => {
        state.accessToken = accessToken;
        state.refreshToken = refreshToken;
        state.user = user;
        state.isAuthenticated = true;
        state.error = null;
      });
    },

    updateUser: (updates) => {
      set((state) => {
        if (state.user) {
          Object.assign(state.user, updates);
          localStorage.setItem(USER_KEY, JSON.stringify(state.user));
        }
      });
    },

    setTokens: (accessToken, refreshToken) => {
      localStorage.setItem(ACCESS_TOKEN_KEY, accessToken);
      localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
      set((state) => {
        state.accessToken = accessToken;
        state.refreshToken = refreshToken;
      });
    },

    clearAuth: () => {
      localStorage.removeItem(ACCESS_TOKEN_KEY);
      localStorage.removeItem(REFRESH_TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
      set((state) => {
        state.accessToken = null;
        state.refreshToken = null;
        state.user = null;
        state.isAuthenticated = false;
        state.error = null;
      });
    },

    setLoading: (loading) => {
      set((state) => {
        state.isLoading = loading;
      });
    },

    setError: (error) => {
      set((state) => {
        state.error = error;
        state.isLoading = false;
      });
    },
  })),
);
