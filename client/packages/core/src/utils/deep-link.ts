import { useInviteStore } from '../store/invite.ts';

export interface DeepLinkInvite {
  host: string;
  code: string;
  secret?: string;
}

/**
 * Parse a `meza://i/{host}/{code}?s={secret}` deep link URL.
 * Returns null for unrecognized or malformed URLs.
 */
export function parseDeepLink(url: string): DeepLinkInvite | null {
  // new URL('meza://i/host/code') treats "i" as hostname and "/host/code" as
  // pathname, so we parse the raw string instead.
  const prefix = 'meza://i/';
  if (!url.startsWith(prefix)) return null;

  const rest = url.slice(prefix.length);
  const [pathPart, queryPart] = rest.split('?', 2);
  const segments = pathPart.split('/');
  if (segments.length < 2) return null;

  const host = segments[0];
  const code = segments[1];
  if (!host || !/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(host) || !/^[a-z0-9]{8}$/i.test(code)) return null;

  const secret = queryPart
    ? new URLSearchParams(queryPart).get('s') || undefined
    : undefined;

  return { host, code, secret };
}

/**
 * Build a `meza://i/{host}/{code}?s={secret}` deep link URL from parts.
 */
export function buildDeepLinkUrl(invite: DeepLinkInvite): string {
  let url = `meza://i/${invite.host}/${invite.code}`;
  if (invite.secret) {
    url += `?s=${encodeURIComponent(invite.secret)}`;
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
