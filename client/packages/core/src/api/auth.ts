import { Code, ConnectError, createClient } from '@connectrpc/connect';
import { AuthService } from '@meza/gen/meza/v1/auth_pb.ts';
import type { AudioPreferences, User } from '@meza/gen/meza/v1/models_pb.ts';
import { registerPublicKey } from '../crypto/credentials.ts';
import { clearCryptoStorage, isSessionReady } from '../crypto/index.ts';
import { disconnect } from '../gateway/gateway.ts';
import { resetSearchState } from '../search/index.ts';
import { getBaseUrl } from '../utils/platform.ts';
import { useAudioSettingsStore } from '../store/audioSettings.ts';
import {
  type ConnectionPlatform,
  type StoredUser,
  useAuthStore,
} from '../store/auth.ts';
import { useBlockStore } from '../store/blocks.ts';
import { useChannelStore } from '../store/channels.ts';
import { useFriendStore } from '../store/friends.ts';
import { useMessageStore } from '../store/messages.ts';
import { usePresenceStore } from '../store/presence.ts';
import { useServerStore } from '../store/servers.ts';
import { useStreamSettingsStore } from '../store/streamSettings.ts';
import { useTypingStore } from '../store/typing.ts';
import { useUsersStore } from '../store/users.ts';
import { useVoiceStore } from '../store/voice.ts';
import { transport } from './client.ts';

const authClient = createClient(AuthService, transport);

export function toStoredUser(user: User): StoredUser {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    emojiScale: user.emojiScale || 1.0,
    bio: user.bio,
    pronouns: user.pronouns,
    bannerUrl: user.bannerUrl,
    themeColorPrimary: user.themeColorPrimary,
    themeColorSecondary: user.themeColorSecondary,
    simpleMode: user.simpleMode,
    dmPrivacy: user.dmPrivacy || 'message_requests',
    connections: user.connections.map((c) => ({
      platform: c.platform as ConnectionPlatform,
      url: c.url,
      label: c.label,
    })),
    createdAt: user.createdAt
      ? new Date(Number(user.createdAt.seconds) * 1000).toISOString()
      : '',
  };
}

function mapAuthError(err: unknown): string {
  if (err instanceof ConnectError) {
    switch (err.code) {
      case Code.AlreadyExists:
        return 'Email or username already taken';
      case Code.Unauthenticated:
        return 'Invalid credentials';
      case Code.NotFound:
        return 'Account not found';
      case Code.InvalidArgument:
        return 'Invalid input. Please check your request.';
      default:
        return 'Something went wrong. Please try again.';
    }
  }
  return 'Network error. Please check your connection.';
}

export async function register(
  params: {
    email: string;
    username: string;
    authKey: Uint8Array;
    salt: Uint8Array;
    encryptedKeyBundle: Uint8Array;
    keyBundleIv: Uint8Array;
    initialKeyPackages?: Uint8Array[];
    recoveryEncryptedKeyBundle?: Uint8Array;
    recoveryKeyBundleIv?: Uint8Array;
    recoveryVerifier?: Uint8Array;
  },
  opts?: { deferAuth?: boolean },
) {
  const store = useAuthStore.getState();
  store.setLoading(true);
  store.setError(null);
  try {
    const res = await authClient.register(params);
    if (res.user && !opts?.deferAuth) {
      store.setAuth(res.accessToken, res.refreshToken, toStoredUser(res.user));
      hydrateAudioPreferences(res.user.audioPreferences);
    }
    return res;
  } catch (err) {
    store.setError(mapAuthError(err));
    throw err;
  } finally {
    store.setLoading(false);
  }
}

/**
 * Finalize a deferred registration by setting auth state.
 * Call this after the user has confirmed their recovery phrase.
 */
export function finalizeRegistration(
  accessToken: string,
  refreshToken: string,
  user: StoredUser,
) {
  useAuthStore.getState().setAuth(accessToken, refreshToken, user);
  // Register signing public key now that we have a valid auth token
  if (isSessionReady()) {
    import('../crypto/session.ts').then(({ getIdentity }) => {
      const id = getIdentity();
      if (id) registerPublicKey(id.publicKey).catch(() => {});
    }).catch(() => {});
  }
}

export async function login(identifier: string, authKey: Uint8Array) {
  const store = useAuthStore.getState();
  store.setLoading(true);
  store.setError(null);
  try {
    const res = await authClient.login({ identifier, authKey });
    if (res.user) {
      store.setAuth(res.accessToken, res.refreshToken, toStoredUser(res.user));
      hydrateAudioPreferences(res.user.audioPreferences);
    }
    return res;
  } catch (err) {
    store.setError(mapAuthError(err));
    throw err;
  } finally {
    store.setLoading(false);
  }
}

export async function getSalt(identifier: string) {
  const res = await authClient.getSalt({ identifier });
  return res.salt;
}

export async function refreshAccessToken(refreshToken: string) {
  const res = await authClient.refreshToken({ refreshToken });
  useAuthStore.getState().setTokens(res.accessToken, res.refreshToken);
  return res;
}

export async function updateProfile(params: {
  displayName?: string;
  avatarUrl?: string;
  emojiScale?: number;
  bio?: string;
  pronouns?: string;
  bannerUrl?: string;
  themeColorPrimary?: string;
  themeColorSecondary?: string;
  simpleMode?: boolean;
  audioPreferences?: {
    noiseSuppression: boolean;
    echoCancellation: boolean;
    autoGainControl: boolean;
    noiseCancellationMode?: string;
  };
  dmPrivacy?: string;
  connections?: { platform: ConnectionPlatform; url: string; label: string }[];
  clearConnections?: boolean;
}) {
  const store = useAuthStore.getState();
  try {
    const res = await authClient.updateProfile(params);
    if (res.user) {
      store.updateUser(toStoredUser(res.user));
    }
    return res;
  } catch (err) {
    throw new Error(mapAuthError(err));
  }
}

export async function getProfile(userId: string): Promise<StoredUser> {
  try {
    const res = await authClient.getProfile({ userId });
    if (!res.user) {
      throw new Error('User not found');
    }
    const profile = toStoredUser(res.user);
    useUsersStore.getState().setProfile(userId, profile);
    return profile;
  } catch (err) {
    if (err instanceof ConnectError && err.code === Code.NotFound) {
      throw new Error('User not found');
    }
    throw new Error(mapAuthError(err));
  }
}

function hydrateAudioPreferences(prefs: AudioPreferences | undefined) {
  if (prefs) {
    useAudioSettingsStore.getState().hydrateFromProfile({
      noiseCancellationMode:
        (prefs.noiseCancellationMode as 'off' | 'standard' | 'giga') ||
        undefined,
      noiseSuppression: prefs.noiseSuppression,
      echoCancellation: prefs.echoCancellation,
      autoGainControl: prefs.autoGainControl,
    });
  }
}

export async function changePassword(params: {
  oldAuthKey: Uint8Array;
  newAuthKey: Uint8Array;
  newSalt: Uint8Array;
  newEncryptedKeyBundle: Uint8Array;
  newKeyBundleIv: Uint8Array;
  newRecoveryEncryptedKeyBundle: Uint8Array;
  newRecoveryKeyBundleIv: Uint8Array;
  newRecoveryVerifier?: Uint8Array;
}) {
  try {
    await authClient.changePassword(params);
  } catch (err) {
    throw new Error(mapAuthError(err), { cause: err });
  }
}

export async function listDevices() {
  try {
    const res = await authClient.listDevices({});
    return res.devices;
  } catch (err) {
    throw new Error(mapAuthError(err), { cause: err });
  }
}

export async function revokeDevice(deviceId: string) {
  try {
    await authClient.revokeDevice({ deviceId });
  } catch (err) {
    throw new Error(mapAuthError(err), { cause: err });
  }
}

export async function revokeAllOtherDevices(): Promise<number> {
  try {
    const res = await authClient.revokeAllOtherDevices({});
    return res.revokedCount;
  } catch (err) {
    throw new Error(mapAuthError(err), { cause: err });
  }
}

export async function getRecoveryBundle(email: string) {
  try {
    const res = await authClient.getRecoveryBundle({ email });
    return {
      recoveryEncryptedKeyBundle: res.recoveryEncryptedKeyBundle,
      recoveryKeyBundleIv: res.recoveryKeyBundleIv,
      salt: res.salt,
    };
  } catch (err) {
    throw new Error(mapAuthError(err), { cause: err });
  }
}

export async function recoverAccount(
  params: {
    email: string;
    newAuthKey: Uint8Array;
    newSalt: Uint8Array;
    newEncryptedKeyBundle: Uint8Array;
    newKeyBundleIv: Uint8Array;
    newRecoveryEncryptedKeyBundle: Uint8Array;
    newRecoveryKeyBundleIv: Uint8Array;
    recoveryVerifier?: Uint8Array;
    newRecoveryVerifier?: Uint8Array;
  },
  opts?: { deferAuth?: boolean },
) {
  const store = useAuthStore.getState();
  store.setLoading(true);
  store.setError(null);
  try {
    const res = await authClient.recoverAccount(params);
    if (res.user && !opts?.deferAuth) {
      store.setAuth(res.accessToken, res.refreshToken, toStoredUser(res.user));
    }
    return res;
  } catch (err) {
    store.setError(mapAuthError(err));
    throw err;
  } finally {
    store.setLoading(false);
  }
}

export async function logout() {
  // Notify the server to invalidate the session (revoke refresh tokens and
  // block the device's access tokens). This is best-effort -- we still clear
  // local state even if the server call fails.
  try {
    const { accessToken } = useAuthStore.getState();
    if (accessToken) {
      const baseUrl = getBaseUrl();
      await fetch(`${baseUrl}/meza.v1.AuthService/Logout`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Connect-Protocol-Version': '1',
          Authorization: `Bearer ${accessToken}`,
        },
        body: '{}',
      });
    }
  } catch {
    // Best-effort: server-side logout failed, proceed with local cleanup.
  }

  disconnect();
  useVoiceStore.getState().disconnect();
  useServerStore.getState().reset();
  useChannelStore.getState().reset();
  useMessageStore.getState().reset();
  usePresenceStore.getState().reset();
  useTypingStore.getState().reset();
  useAudioSettingsStore.getState().reset();
  useStreamSettingsStore.getState().reset();
  useBlockStore.getState().reset();
  useFriendStore.getState().reset();
  resetSearchState();
  await clearCryptoStorage();
  useAuthStore.getState().clearAuth();
}
