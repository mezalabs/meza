/**
 * Canonical spec for push-notification deep-link URLs that flow from the
 * Electron main process (notification:show IPC handler) through the
 * deep-link:navigate IPC into the renderer (handled in main.tsx).
 *
 * Wire format:
 *   meza://channel/{channelId}[?user_id={recipientUserId}]
 *   meza://dm/{conversationId}[?user_id={recipientUserId}]
 *
 * The user_id query param is forwarded to navigateFromPush so the
 * cross-account leak filter applies on Electron tap.
 *
 * SYNC: client/packages/desktop/src/main/ipc.ts has its own inline builder
 * because @meza/desktop does not depend on @meza/core. If you change the
 * URL shape here, update the builder in ipc.ts to match.
 */

export type PushDeepLinkKind = 'channel' | 'dm';

export interface PushDeepLink {
  kind: PushDeepLinkKind;
  channelId: string;
  userId?: string;
}

const ID_PATTERN = '[a-zA-Z0-9_-]+';
const URL_PATTERN = new RegExp(
  `^meza:\\/\\/(channel|dm)\\/(${ID_PATTERN})(?:\\?(.+))?$`,
);

/** Maximum length of the query-string we'll attempt to parse — defensive
 *  bound against a hostile notification handler emitting megabyte payloads. */
const MAX_QUERY_LENGTH = 1024;

export function buildPushDeepLink(d: PushDeepLink): string {
  const base = `meza://${d.kind}/${d.channelId}`;
  if (!d.userId) return base;
  const params = new URLSearchParams({ user_id: d.userId });
  return `${base}?${params.toString()}`;
}

export function parsePushDeepLink(url: string): PushDeepLink | null {
  const m = url.match(URL_PATTERN);
  if (!m) return null;
  const kind = m[1] === 'dm' ? 'dm' : 'channel';
  const channelId = m[2];
  const params = new URLSearchParams((m[3] ?? '').slice(0, MAX_QUERY_LENGTH));
  const userId = params.get('user_id') ?? undefined;
  return { kind, channelId, userId };
}
