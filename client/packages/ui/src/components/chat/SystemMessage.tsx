import { formatRelativeTime, MessageType, toISO } from '@meza/core';
import * as Popover from '@radix-ui/react-popover';
import { memo, useMemo, useRef, useState } from 'react';
import { useDisplayName } from '../../hooks/useDisplayName.ts';
import { openProfilePane } from '../../stores/tiling.ts';

interface SystemMessageProps {
  type: number;
  encryptedContent: Uint8Array;
  createdAt?: { seconds: bigint };
  serverId: string | undefined;
}

export interface GroupedJoinMessageProps {
  /** All user IDs in this group (first is the "lead" name). */
  userIds: string[];
  /** Timestamp of the most recent join in the group. */
  createdAt?: { seconds: bigint };
  serverId: string | undefined;
}

/** JSON shapes stored in encrypted_content for each system message type. */
interface MemberEventContent {
  user_id: string;
  actor_id?: string;
}

interface MemberKickContent {
  user_id: string;
  actor_id: string;
  action: 'kick' | 'ban' | 'timeout';
  reason?: string;
  duration_seconds?: number;
}

interface ChannelUpdateContent {
  actor_id: string;
  field: 'name' | 'topic';
  old_value: string;
  new_value: string;
}

interface KeyRotationContent {
  actor_id: string;
  new_key_version: number;
}

function iconForType(type: number): string {
  switch (type) {
    case MessageType.MEMBER_JOIN:
      return '\u2192';
    case MessageType.MEMBER_LEAVE:
      return '\u2190';
    case MessageType.MEMBER_KICK:
      return '\u26D4';
    case MessageType.CHANNEL_UPDATE:
      return '\u270E';
    case MessageType.KEY_ROTATION:
      return '\uD83D\uDD11';
    default:
      return '\u2139';
  }
}

function parseContent(raw: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return null;
  }
}

/** Resolve a user ID to display name, falling back to a short ID. */
function UserName({
  userId,
  serverId,
}: {
  userId: string;
  serverId: string | undefined;
}) {
  const name = useDisplayName(userId, serverId);
  return (
    <button
      type="button"
      className="font-medium text-text hover:underline cursor-pointer"
      onClick={() => openProfilePane(userId)}
    >
      {name}
    </button>
  );
}

function useSystemMessageText(
  type: number,
  encryptedContent: Uint8Array,
  serverId: string | undefined,
): { icon: string; node: React.ReactNode } {
  const content = useMemo(
    () => parseContent(encryptedContent),
    [encryptedContent],
  );

  // If server rendered a custom template, use it directly.
  const rendered = (content as Record<string, unknown> | null)?.rendered;
  if (typeof rendered === 'string') {
    return { icon: iconForType(type), node: <span>{rendered}</span> };
  }

  switch (type) {
    case MessageType.MEMBER_JOIN: {
      const c = content as MemberEventContent | null;
      if (!c?.user_id) return { icon: '\u2192', node: 'A member joined' };
      return {
        icon: '\u2192',
        node: (
          <>
            <UserName userId={c.user_id} serverId={serverId} /> joined the
            {serverId ? ' server' : ' group'}
          </>
        ),
      };
    }
    case MessageType.MEMBER_LEAVE: {
      const c = content as MemberEventContent | null;
      if (!c?.user_id) return { icon: '\u2190', node: 'A member left' };
      return {
        icon: '\u2190',
        node: (
          <>
            <UserName userId={c.user_id} serverId={serverId} /> left the
            {serverId ? ' server' : ' group'}
          </>
        ),
      };
    }
    case MessageType.MEMBER_KICK: {
      const c = content as MemberKickContent | null;
      if (!c?.user_id) return { icon: '\u26D4', node: 'A member was removed' };
      const actionLabel =
        c.action === 'ban'
          ? 'was banned'
          : c.action === 'timeout'
            ? 'was timed out'
            : 'was kicked';
      return {
        icon: '\u26D4',
        node: (
          <>
            <UserName userId={c.user_id} serverId={serverId} /> {actionLabel}
            {c.actor_id && (
              <>
                {' '}
                by <UserName userId={c.actor_id} serverId={serverId} />
              </>
            )}
            {c.reason && (
              <span className="text-text-subtle"> — {c.reason}</span>
            )}
            {c.action === 'timeout' && c.duration_seconds && (
              <span className="text-text-subtle">
                {' '}
                for {formatDuration(c.duration_seconds)}
              </span>
            )}
          </>
        ),
      };
    }
    case MessageType.CHANNEL_UPDATE: {
      const c = content as ChannelUpdateContent | null;
      if (!c?.actor_id) return { icon: '\u270E', node: 'Channel was updated' };
      const what =
        c.field === 'name'
          ? `changed the channel name to "${c.new_value}"`
          : `changed the channel topic to "${c.new_value}"`;
      return {
        icon: '\u270E',
        node: (
          <>
            <UserName userId={c.actor_id} serverId={serverId} /> {what}
          </>
        ),
      };
    }
    case MessageType.KEY_ROTATION: {
      const c = content as KeyRotationContent | null;
      return {
        icon: '\uD83D\uDD11',
        node: c?.actor_id ? (
          <>
            <UserName userId={c.actor_id} serverId={serverId} /> rotated the
            channel encryption key
          </>
        ) : (
          'Channel encryption key was rotated'
        ),
      };
    }
    default:
      return { icon: '\u2139', node: 'System message' };
  }
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

export const SystemMessage = memo(function SystemMessage({
  type,
  encryptedContent,
  createdAt,
  serverId,
}: SystemMessageProps) {
  const { icon, node } = useSystemMessageText(type, encryptedContent, serverId);
  const time = createdAt ? new Date(Number(createdAt.seconds) * 1000) : null;

  return (
    <div className="flex items-center justify-center gap-2 py-1 px-4">
      <div className="h-px flex-1 bg-border" />
      <span className="flex items-center gap-1.5 text-xs text-text-muted whitespace-nowrap">
        <span>{icon}</span>
        <span>{node}</span>
        {time && (
          <span className="text-text-subtle" title={toISO(time)}>
            {formatRelativeTime(time)}
          </span>
        )}
      </span>
      <div className="h-px flex-1 bg-border" />
    </div>
  );
});

/** Renders a single name in the popover list. */
function PopoverUserName({
  userId,
  serverId,
}: {
  userId: string;
  serverId: string | undefined;
}) {
  const name = useDisplayName(userId, serverId);
  return (
    <button
      type="button"
      className="truncate text-left hover:underline cursor-pointer px-1 py-0.5 rounded hover:bg-surface-hover"
      onClick={() => openProfilePane(userId)}
    >
      {name}
    </button>
  );
}

export const GroupedJoinMessage = memo(function GroupedJoinMessage({
  userIds,
  createdAt,
  serverId,
}: GroupedJoinMessageProps) {
  const time = createdAt ? new Date(Number(createdAt.seconds) * 1000) : null;
  const othersCount = userIds.length - 1;
  const [open, setOpen] = useState(false);
  const hoverTimeout = useRef<ReturnType<typeof setTimeout>>(undefined);

  const openPopover = () => {
    clearTimeout(hoverTimeout.current);
    setOpen(true);
  };
  const closePopover = () => {
    hoverTimeout.current = setTimeout(() => setOpen(false), 150);
  };

  return (
    <div className="flex items-center justify-center gap-2 py-1 px-4">
      <div className="h-px flex-1 bg-border" />
      <span className="flex items-center gap-1.5 text-xs text-text-muted whitespace-nowrap">
        <span>{'\u2192'}</span>
        <span>
          <UserName userId={userIds[0]} serverId={serverId} />
          {othersCount > 0 && (
            <>
              {' and '}
              <Popover.Root open={open} onOpenChange={setOpen}>
                <Popover.Trigger asChild>
                  <button
                    type="button"
                    className="underline decoration-dotted underline-offset-2 hover:text-text cursor-pointer"
                    onMouseEnter={openPopover}
                    onMouseLeave={closePopover}
                  >
                    {othersCount} {othersCount === 1 ? 'other' : 'others'}
                  </button>
                </Popover.Trigger>
                <Popover.Portal>
                  <Popover.Content
                    className="z-50 rounded-lg border border-border bg-surface-overlay p-2 shadow-lg text-xs text-text data-[state=open]:animate-scale-in data-[state=closed]:animate-scale-out"
                    side="top"
                    sideOffset={4}
                    onMouseEnter={openPopover}
                    onMouseLeave={closePopover}
                    onOpenAutoFocus={(e) => e.preventDefault()}
                  >
                    <div className="flex flex-col gap-0.5 max-h-48 overflow-y-auto">
                      {userIds.slice(1).map((uid) => (
                        <PopoverUserName
                          key={uid}
                          userId={uid}
                          serverId={serverId}
                        />
                      ))}
                    </div>
                  </Popover.Content>
                </Popover.Portal>
              </Popover.Root>
            </>
          )}{' '}
          joined the {serverId ? 'server' : 'group'}
        </span>
        {time && (
          <span className="text-text-subtle" title={toISO(time)}>
            {formatRelativeTime(time)}
          </span>
        )}
      </span>
      <div className="h-px flex-1 bg-border" />
    </div>
  );
});
