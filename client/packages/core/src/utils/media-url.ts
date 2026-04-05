import { useAuthStore } from '../store/auth.ts';
import { useFederationStore } from '../store/federation.ts';
import { getBaseUrl } from './platform.ts';

/**
 * Resolve a media URL that works for both origin and spoke servers.
 *
 * For origin servers: uses getBaseUrl() + origin access token.
 * For federated servers: uses the spoke's instanceUrl + spoke access token.
 *
 * SECURITY NOTE: The access token is appended as a query parameter, which
 * means it appears in server logs, browser history, and Referer headers.
 * For spoke servers this means the spoke operator can observe the token.
 * Access token TTL is 1 hour — a meaningful exposure window. A future
 * improvement would use Authorization-header-based fetch + blob URLs
 * (like E2EE media) to avoid token exposure in URLs.
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
