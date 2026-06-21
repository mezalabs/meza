import { PresenceStatus } from '@meza/gen/meza/v1/presence_pb.ts';
import { useBlockStore } from '../store/blocks.ts';
import { useChannelStore } from '../store/channels.ts';
import { useDMStore } from '../store/dms.ts';
import { useNotificationSettingsStore } from '../store/notificationSettings.ts';
import { usePresenceStore } from '../store/presence.ts';
import { useUsersStore } from '../store/users.ts';
import { getDMDisplayName, isGroupDM } from '../utils/dm.ts';
import { isElectron } from '../utils/platform.ts';

/**
 * Desktop (Electron) push notifications.
 *
 * The desktop app has no OS-level push service to wake a fully-quit process
 * (unlike browsers with web-push or mobile with FCM/APNs). Instead it shows a
 * native OS notification straight off the live gateway connection while the app
 * is running — typically minimized to the tray. The server deliberately skips
 * pushing to a connected device, so this client-side path is the only one that
 * fires for desktop. See `core/src/gateway/gateway.ts` for the call site.
 *
 * Notification bodies are intentionally generic (sender + location, never
 * message text): messages are end-to-end encrypted and OS notifications can
 * surface on lock screens.
 */

export interface DesktopNotificationData {
  channelId: string;
  kind: 'dm' | 'channel';
  /**
   * The RECIPIENT (current user) id, not the sender — `ipc.ts` forwards it as
   * the `meza://…?user_id=` param and `navigateFromPush` drops the tap unless
   * it equals the signed-in user (multi-account leak prevention). See
   * client/packages/web/src/push-deeplink.ts and web/src/navigate.ts.
   */
  userId: string;
}

export interface DesktopNotification {
  title: string;
  body: string;
  data: DesktopNotificationData;
}

export interface BuildDesktopNotificationInput {
  channelId: string;
  /** RECIPIENT (current user) id — becomes `data.userId`. See its doc above. */
  recipientUserId: string;
  isMention: boolean;
  isDM: boolean;
  /** Resolved display name of the message author. */
  senderName: string;
  /** Server channel name (no leading '#'); undefined for DMs/unknown channels. */
  channelName?: string;
  /** Group-DM display name; undefined for 1-on-1 DMs and server channels. */
  groupName?: string;
}

/**
 * Pure builder for an Electron native notification's title/body/data. The
 * `data` shape matches what `desktop/src/main/ipc.ts` consumes to route a click
 * to the right conversation via the `meza://` deep link.
 */
export function buildDesktopNotification(
  input: BuildDesktopNotificationInput,
): DesktopNotification {
  const {
    channelId,
    recipientUserId,
    isMention,
    isDM,
    senderName,
    channelName,
    groupName,
  } = input;

  const data: DesktopNotificationData = {
    channelId,
    kind: isDM ? 'dm' : 'channel',
    userId: recipientUserId,
  };

  if (isDM) {
    // Group DM: title is the group name, sender lives in the body.
    if (groupName) {
      return { title: groupName, body: `${senderName} sent a message`, data };
    }
    // 1-on-1 DM: the sender IS the conversation.
    return {
      title: senderName,
      body: isMention ? 'mentioned you' : 'sent you a message',
      data,
    };
  }

  // Server channel.
  const title = channelName ? `#${channelName}` : senderName;
  const body = isMention
    ? `${senderName} mentioned you`
    : `${senderName} sent a message`;
  return { title, body, data };
}

function resolveSenderName(authorId: string, channelId: string): string {
  const profile = useUsersStore.getState().getProfile(authorId);
  if (profile) return profile.displayName || profile.username || 'Someone';

  // Fallback: a brand-new DM may not be in the users store yet, but the sender
  // is among the DM channel's participants.
  const dm = useDMStore
    .getState()
    .dmChannels.find((c) => c.channel?.id === channelId);
  const participant = dm?.participants.find((p) => p.id === authorId);
  if (participant) {
    return participant.displayName || participant.username || 'Someone';
  }
  return 'Someone';
}

function resolveLocation(
  channelId: string,
  isDM: boolean,
  currentUserId: string | null | undefined,
): { channelName?: string; groupName?: string } {
  if (isDM) {
    const dm = useDMStore
      .getState()
      .dmChannels.find((c) => c.channel?.id === channelId);
    if (dm && isGroupDM(dm)) {
      return { groupName: getDMDisplayName(dm, currentUserId ?? '') };
    }
    return {};
  }

  const { channelToServer, byServer } = useChannelStore.getState();
  const serverId = channelToServer[channelId];
  const channel = serverId
    ? byServer[serverId]?.find((c) => c.id === channelId)
    : undefined;
  return { channelName: channel?.name };
}

export interface MaybeShowDesktopNotificationArgs {
  channelId: string;
  authorId: string;
  isMention: boolean;
  isDM: boolean;
  /** Gateway reconnect grace deadline (epoch ms); suppresses backlog floods. */
  reconnectGraceUntil: number;
  currentUserId: string | null | undefined;
}

/**
 * Show a native OS notification for an incoming message when running under
 * Electron and the window is not in front of the user. Reuses `maybePlaySound`'s
 * gating (reconnect grace, DND, blocked author) plus a window-focus gate and the
 * user's notification level (`badgeMode`).
 *
 * It intentionally omits `maybePlaySound`'s `isPrimaryTab` cross-tab guard:
 * notifications are gated to Electron (single-window), so the window-focus gate
 * is the right discriminator and there's no second tab to coordinate with.
 */
export function maybeShowDesktopNotification(
  args: MaybeShowDesktopNotificationArgs,
): void {
  if (!isElectron()) return;
  const api = typeof window !== 'undefined' ? window.electronAPI : undefined;
  if (!api) return;

  // Suppress notifications briefly after (re)connect. The gateway uses live
  // (non-replaying) NATS, so there's no server backlog flood — but a flap can
  // deliver a quick burst of live messages right as the socket re-establishes;
  // this avoids surfacing all of them as separate toasts. Messages that arrived
  // while disconnected come back via the REST refetch, which bypasses this path.
  if (Date.now() < args.reconnectGraceUntil) return;

  // Only notify when the window isn't actively in front of the user. A
  // tray-minimized window reports hidden; a background window reports unfocused.
  if (
    typeof document !== 'undefined' &&
    document.visibilityState === 'visible' &&
    document.hasFocus()
  ) {
    return;
  }

  // Do Not Disturb.
  if (usePresenceStore.getState().myStatus === PresenceStatus.DND) return;

  // Blocked author.
  if (useBlockStore.getState().isBlocked(args.authorId)) return;

  // Notification level — reuse the existing badge preference.
  const { badgeMode } = useNotificationSettingsStore.getState();
  if (badgeMode === 'off') return;
  if (badgeMode === 'mentions_dms' && !args.isMention && !args.isDM) return;

  const senderName = resolveSenderName(args.authorId, args.channelId);
  const { channelName, groupName } = resolveLocation(
    args.channelId,
    args.isDM,
    args.currentUserId,
  );

  const notification = buildDesktopNotification({
    channelId: args.channelId,
    recipientUserId: args.currentUserId ?? '',
    isMention: args.isMention,
    isDM: args.isDM,
    senderName,
    channelName,
    groupName,
  });

  api.notifications.show(
    notification.title,
    notification.body,
    notification.data,
  );
}
