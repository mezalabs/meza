import { Code, ConnectError } from '@connectrpc/connect';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '../store/auth.ts';
import { useChannelStore } from '../store/channels.ts';
import { useMessageStore } from '../store/messages.ts';
import { usePresenceStore } from '../store/presence.ts';
import { useServerStore } from '../store/servers.ts';
import { useTypingStore } from '../store/typing.ts';
import { useVoiceStore } from '../store/voice.ts';

// ---------------------------------------------------------------------------
// Mock the ConnectRPC auth client
// ---------------------------------------------------------------------------
const mockAuthClient: Record<string, ReturnType<typeof vi.fn>> = {
  register: vi.fn(),
  login: vi.fn(),
  getSalt: vi.fn(),
  refreshToken: vi.fn(),
  updateProfile: vi.fn(),
};

vi.mock('@connectrpc/connect', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    createClient: vi.fn(() => mockAuthClient),
  };
});

vi.mock('./client.ts', () => ({
  transport: {},
}));

vi.mock('../gateway/gateway.ts', () => ({
  disconnect: vi.fn(),
}));

const mockStorage = new Map<string, string>();

beforeEach(() => {
  vi.clearAllMocks();
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
  useServerStore.setState({ servers: {}, isLoading: false, error: null });
  useChannelStore.setState({ byServer: {}, isLoading: false, error: null });
  useMessageStore.setState({
    byChannel: {},
    byId: {},
    hasMore: {},
    isLoading: {},
    error: {},
    viewMode: {},
    replyingTo: {},
  });
  usePresenceStore.setState({ byUser: {} });
  useTypingStore.setState({ byChannel: {} });
  useVoiceStore.setState({
    status: 'idle',
    livekitUrl: null,
    livekitToken: null,
    channelId: null,
    channelName: null,
    canScreenShare: false,
    error: null,
  });
});

// ---------------------------------------------------------------------------
// login
// ---------------------------------------------------------------------------
describe('login', () => {
  it('sets auth on success', async () => {
    const { login } = await import('./auth.ts');
    mockAuthClient.login.mockResolvedValue({
      accessToken: 'at',
      refreshToken: 'rt',
      user: {
        id: 'u1',
        username: 'alice',
        displayName: 'Alice',
        avatarUrl: '',
        emojiScale: 1.0,
        connections: [],
      },
    });

    await login('alice@test.com', new Uint8Array([1, 2, 3]));

    const state = useAuthStore.getState();
    expect(state.accessToken).toBe('at');
    expect(state.user?.username).toBe('alice');
    expect(state.isLoading).toBe(false);
  });

  it('maps Unauthenticated to "Invalid credentials"', async () => {
    const { login } = await import('./auth.ts');
    mockAuthClient.login.mockRejectedValue(
      new ConnectError('bad creds', Code.Unauthenticated),
    );

    await expect(login('a@b.com', new Uint8Array())).rejects.toThrow();
    expect(useAuthStore.getState().error).toBe('Invalid credentials');
  });

  it('maps NotFound to "Account not found"', async () => {
    const { login } = await import('./auth.ts');
    mockAuthClient.login.mockRejectedValue(
      new ConnectError('no user', Code.NotFound),
    );

    await expect(login('a@b.com', new Uint8Array())).rejects.toThrow();
    expect(useAuthStore.getState().error).toBe('Account not found');
  });
});

// ---------------------------------------------------------------------------
// register
// ---------------------------------------------------------------------------
describe('register', () => {
  it('sets auth on success', async () => {
    const { register } = await import('./auth.ts');
    mockAuthClient.register.mockResolvedValue({
      accessToken: 'at',
      refreshToken: 'rt',
      user: {
        id: 'u1',
        username: 'bob',
        displayName: 'Bob',
        avatarUrl: '',
        emojiScale: 1.0,
        connections: [],
      },
    });

    await register({
      email: 'bob@test.com',
      username: 'bob',
      authKey: new Uint8Array(),
      salt: new Uint8Array(),
      encryptedKeyBundle: new Uint8Array(),
      keyBundleIv: new Uint8Array(),
    });

    expect(useAuthStore.getState().user?.username).toBe('bob');
  });

  it('maps AlreadyExists to friendly message', async () => {
    const { register } = await import('./auth.ts');
    mockAuthClient.register.mockRejectedValue(
      new ConnectError('dup', Code.AlreadyExists),
    );

    await expect(
      register({
        email: 'x@x.com',
        username: 'x',
        authKey: new Uint8Array(),
        salt: new Uint8Array(),
        encryptedKeyBundle: new Uint8Array(),
        keyBundleIv: new Uint8Array(),
      }),
    ).rejects.toThrow();
    expect(useAuthStore.getState().error).toBe(
      'Email or username already taken',
    );
  });
});

// ---------------------------------------------------------------------------
// getSalt
// ---------------------------------------------------------------------------
describe('getSalt', () => {
  it('returns salt on success', async () => {
    const { getSalt } = await import('./auth.ts');
    mockAuthClient.getSalt.mockResolvedValue({
      salt: new Uint8Array([1, 2, 3]),
    });

    const salt = await getSalt('a@b.com');
    expect(salt).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('throws for NotFound', async () => {
    const { getSalt } = await import('./auth.ts');
    mockAuthClient.getSalt.mockRejectedValue(
      new ConnectError('no user', Code.NotFound),
    );

    await expect(getSalt('missing@b.com')).rejects.toThrow();
  });

  it('throws for other errors', async () => {
    const { getSalt } = await import('./auth.ts');
    mockAuthClient.getSalt.mockRejectedValue(
      new ConnectError('fail', Code.Internal),
    );

    await expect(getSalt('a@b.com')).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// refreshAccessToken
// ---------------------------------------------------------------------------
describe('refreshAccessToken', () => {
  it('updates tokens in store', async () => {
    const { refreshAccessToken } = await import('./auth.ts');
    mockAuthClient.refreshToken.mockResolvedValue({
      accessToken: 'new-at',
      refreshToken: 'new-rt',
    });

    await refreshAccessToken('old-rt');
    const state = useAuthStore.getState();
    expect(state.accessToken).toBe('new-at');
    expect(state.refreshToken).toBe('new-rt');
  });

  it('propagates errors from the refresh call', async () => {
    const { refreshAccessToken } = await import('./auth.ts');
    mockAuthClient.refreshToken.mockRejectedValue(
      new ConnectError('expired', Code.Unauthenticated),
    );

    await expect(refreshAccessToken('bad-rt')).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// updateProfile
// ---------------------------------------------------------------------------
describe('updateProfile', () => {
  it('updates user in store', async () => {
    const { updateProfile } = await import('./auth.ts');
    useAuthStore.setState({
      user: {
        id: 'u1',
        username: 'me',
        displayName: 'Old',
        avatarUrl: '',
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
        dismissedTips: [],
      },
    });
    mockAuthClient.updateProfile.mockResolvedValue({
      user: {
        id: 'u1',
        displayName: 'New Name',
        avatarUrl: '/new',
        emojiScale: 1.5,
        connections: [],
      },
    });

    await updateProfile({
      displayName: 'New Name',
      avatarUrl: '/new',
      emojiScale: 1.5,
    });
    const user = useAuthStore.getState().user;
    expect(user?.displayName).toBe('New Name');
    expect(user?.emojiScale).toBe(1.5);
  });

  it('wraps error with fixed user-facing message', async () => {
    const { updateProfile } = await import('./auth.ts');
    mockAuthClient.updateProfile.mockRejectedValue(
      new ConnectError('bad arg', Code.InvalidArgument),
    );

    await expect(updateProfile({ displayName: 'X' })).rejects.toThrow(
      'Invalid input. Please check your request.',
    );
  });
});

// ---------------------------------------------------------------------------
// logout
// ---------------------------------------------------------------------------
describe('logout', () => {
  it('resets all stores', async () => {
    const { logout } = await import('./auth.ts');
    // Seed some state
    useServerStore.getState().addServer({ id: 's1', name: 'Test' } as never);
    useChannelStore.getState().addChannel({
      id: 'ch1',
      serverId: 's1',
      name: 'gen',
      position: 0,
    } as never);
    useAuthStore.setState({
      accessToken: 'tok',
      user: {
        id: 'u1',
        username: 'me',
        displayName: 'Me',
        avatarUrl: '',
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
        dismissedTips: [],
      },
    });

    await logout();

    expect(useAuthStore.getState().accessToken).toBeNull();
    expect(useServerStore.getState().servers).toEqual({});
    expect(useChannelStore.getState().byServer).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Non-ConnectError maps to network error
// ---------------------------------------------------------------------------
describe('error mapping', () => {
  it('maps non-ConnectError to network error message', async () => {
    const { login } = await import('./auth.ts');
    mockAuthClient.login.mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(login('a@b.com', new Uint8Array())).rejects.toThrow();
    expect(useAuthStore.getState().error).toBe(
      'Network error. Please check your connection.',
    );
  });
});
