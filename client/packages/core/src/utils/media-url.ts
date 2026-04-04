import { useAuthStore } from '../store/auth.ts';
import { useFederationStore } from '../store/federation.ts';
import { getBaseUrl } from './platform.ts';

/**
 * Resolve a media URL that works for both origin and spoke servers.
 *
 * For origin servers: uses getBaseUrl() + origin access token.
 * For federated servers: uses the spoke's instanceUrl + spoke access token.
 */
export function resolveMediaUrl(
  serverId: string,
  path: string,
  opts?: { thumb?: boolean },
): string {
  const instanceUrl = useFederationStore.getState().serverIndex[serverId];
  const base = instanceUrl ?? getBaseUrl();
  const token = instanceUrl
    ? useFederationStore.getState().spokes[instanceUrl]?.accessToken
    : useAuthStore.getState().accessToken;
  const suffix = opts?.thumb ? '/thumb' : '';
  const query = token ? `?token=${encodeURIComponent(token)}` : '';
  return `${base}${path}${suffix}${query}`;
}
