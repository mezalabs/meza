import {
  Code,
  ConnectError,
  type Interceptor,
  type Transport,
} from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-web';
import type { DescService } from '@bufbuild/protobuf';
import { createClient } from '@connectrpc/connect';
import { HOME_INSTANCE } from '../gateway/gateway.ts';
import { useAuthStore } from '../store/auth.ts';
import { useInstanceStore } from '../store/instances.ts';
import { getBaseUrl } from '../utils/platform.ts';

const PUBLIC_METHODS = new Set([
  'meza.v1.AuthService/Register',
  'meza.v1.AuthService/Login',
  'meza.v1.AuthService/GetSalt',
  'meza.v1.AuthService/RefreshToken',
  'meza.v1.ChatService/ResolveInvite',
]);

// Per-instance refresh promise deduplication
const refreshPromises = new Map<string, Promise<boolean>>();

async function refreshTokensForInstance(
  instanceUrl: string,
): Promise<boolean> {
  if (instanceUrl === HOME_INSTANCE) {
    // Home instance: use existing auth store refresh flow
    const { refreshToken } = useAuthStore.getState();
    if (!refreshToken) {
      useAuthStore.getState().clearAuth();
      return false;
    }

    try {
      const { refreshAccessToken } = await import('./auth.ts');
      await refreshAccessToken(refreshToken);
      return true;
    } catch {
      useAuthStore.getState().clearAuth();
      return false;
    }
  }

  // Satellite instances: refresh via federation assertion flow
  try {
    const { refreshSatelliteToken } = await import('./federation-refresh.ts');
    return await refreshSatelliteToken(instanceUrl);
  } catch {
    return false;
  }
}

function createAuthInterceptor(instanceUrl: string): Interceptor {
  return (next) => async (req) => {
    const procedureName = `${req.service.typeName}/${req.method.name}`;
    const isPublic = PUBLIC_METHODS.has(procedureName);

    if (!isPublic) {
      const token = getTokenForInstance(instanceUrl);
      if (token) {
        req.header.set('Authorization', `Bearer ${token}`);
      }
    }

    try {
      return await next(req);
    } catch (err) {
      if (
        !isPublic &&
        err instanceof ConnectError &&
        err.code === Code.Unauthenticated
      ) {
        let refreshPromise = refreshPromises.get(instanceUrl);
        if (!refreshPromise) {
          refreshPromise = refreshTokensForInstance(instanceUrl).finally(() => {
            refreshPromises.delete(instanceUrl);
          });
          refreshPromises.set(instanceUrl, refreshPromise);
        }

        const success = await refreshPromise;
        if (!success) throw err;

        const newToken = getTokenForInstance(instanceUrl);
        if (newToken) {
          req.header.set('Authorization', `Bearer ${newToken}`);
        }
        return next(req);
      }
      throw err;
    }
  };
}

function getTokenForInstance(instanceUrl: string): string | null {
  if (instanceUrl === HOME_INSTANCE) {
    return useAuthStore.getState().accessToken;
  }

  const instance = useInstanceStore.getState().getInstance(instanceUrl);
  if (
    instance &&
    (instance.status === 'connected' || instance.status === 'reconnecting')
  ) {
    return instance.accessToken;
  }
  return null;
}

function createTransportForInstance(instanceUrl: string): Transport {
  const baseUrl =
    instanceUrl === HOME_INSTANCE ? getBaseUrl() : instanceUrl;

  return createConnectTransport({
    baseUrl,
    interceptors: [createAuthInterceptor(instanceUrl)],
  });
}

// Transport registry: one transport per instance URL
const transports = new Map<string, Transport>();

/**
 * Get or create a ConnectRPC transport for the given instance.
 * - HOME_INSTANCE (or omitted): uses the home instance transport (relative URL / Vite proxy)
 * - Satellite URL: creates a transport with the absolute URL and per-instance auth
 */
export function getTransport(instanceUrl?: string): Transport {
  const key = instanceUrl ?? HOME_INSTANCE;
  const existing = transports.get(key);
  if (existing) return existing;

  const t = createTransportForInstance(key);
  transports.set(key, t);
  return t;
}

/**
 * Remove a transport when an instance is disconnected.
 */
export function removeTransport(instanceUrl: string): void {
  transports.delete(instanceUrl);
}

/**
 * Create a typed ConnectRPC client for the given service, optionally scoped
 * to a specific federation instance. Omitting instanceUrl targets the home
 * instance (backward-compatible with all existing call sites).
 */
export function createInstanceClient<T extends DescService>(
  service: T,
  instanceUrl?: string,
) {
  return createClient(service, getTransport(instanceUrl));
}

/**
 * Default home-instance transport — backward-compatible export so existing
 * call sites (`import { transport } from './client.ts'`) keep working.
 */
export const transport: Transport = getTransport();
