import { Code, ConnectError, type Interceptor } from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-web';
import { useAuthStore } from '../store/auth.ts';
import { getBaseUrl } from '../utils/platform.ts';

const PUBLIC_METHODS = new Set([
  'meza.v1.AuthService/Register',
  'meza.v1.AuthService/Login',
  'meza.v1.AuthService/GetSalt',
  'meza.v1.AuthService/RefreshToken',
  'meza.v1.ChatService/ResolveInvite',
  'meza.v1.ChatService/ResolveBotInvite',
]);

let refreshPromise: Promise<boolean> | null = null;

async function refreshTokens(): Promise<boolean> {
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

const authInterceptor: Interceptor = (next) => async (req) => {
  const procedureName = `${req.service.typeName}/${req.method.name}`;
  const isPublic = PUBLIC_METHODS.has(procedureName);

  if (!isPublic) {
    const { accessToken } = useAuthStore.getState();
    if (accessToken) {
      req.header.set('Authorization', `Bearer ${accessToken}`);
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
      if (!refreshPromise) {
        refreshPromise = refreshTokens().finally(() => {
          refreshPromise = null;
        });
      }

      const success = await refreshPromise;
      if (!success) throw err;

      const { accessToken } = useAuthStore.getState();
      if (accessToken) {
        req.header.set('Authorization', `Bearer ${accessToken}`);
      }
      return next(req);
    }
    throw err;
  }
};

export const transport = createConnectTransport({
  baseUrl: getBaseUrl(),
  interceptors: [authInterceptor],
});
