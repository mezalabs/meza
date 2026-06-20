import { useInviteStore } from '../store/invite.ts';

export interface DeepLinkInvite {
  host: string;
  code: string;
  secret?: string;
}

/**
 * Parse a `meza://i/{host}/{code}#{secret}` deep link URL.
 * Returns null for unrecognized or malformed URLs.
 *
 * The secret lives in a URL fragment (not a query parameter) so that if a
 * browser falls back to navigating the current tab on a failed protocol
 * launch, the secret is less likely to be retained by history-tracking
 * tooling than a `?s=` query string would be.
 */
export function parseDeepLink(url: string): DeepLinkInvite | null {
  // new URL('meza://i/host/code') treats "i" as hostname and "/host/code" as
  // pathname, so we parse the raw string instead.
  const prefix = 'meza://i/';
  if (!url.startsWith(prefix)) return null;

  const rest = url.slice(prefix.length);
  // Strip any legacy `?s=` query first so old links keep working.
  const [beforeQuery, queryPart] = rest.split('?', 2);
  const [pathPart, fragmentPart] = beforeQuery.split('#', 2);
  const segments = pathPart.split('/');
  if (segments.length < 2) return null;

  const host = segments[0];
  const code = segments[1];
  if (
    !host ||
    !/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(host) ||
    !/^[a-z0-9]{8}$/i.test(code)
  )
    return null;

  let secret: string | undefined;
  if (fragmentPart) {
    secret = fragmentPart;
  } else if (queryPart) {
    secret = new URLSearchParams(queryPart).get('s') || undefined;
  }

  return { host, code, secret };
}

/**
 * Build a `meza://i/{host}/{code}#{secret}` deep link URL from parts.
 */
export function buildDeepLinkUrl(invite: DeepLinkInvite): string {
  let url = `meza://i/${invite.host}/${invite.code}`;
  if (invite.secret) {
    // Base64url is already URL-safe; no encoding needed.
    url += `#${invite.secret}`;
  }
  return url;
}

/**
 * Write a parsed deep link invite into the invite store.
 * Shared by Electron and Capacitor deep link handlers.
 */
export function applyDeepLinkInvite(invite: DeepLinkInvite): void {
  const store = useInviteStore.getState();
  store.setPendingHost(invite.host);
  store.setPendingCode(invite.code);
  store.setInviteSecret(invite.secret ?? null);
}
