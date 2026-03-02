import { useAuthStore, useMemberStore, useRoleStore } from '@meza/core';
import { useMemo } from 'react';
import { useDisplayColor } from '../../hooks/useDisplayColor.ts';
import { resolveDisplayName } from '../../hooks/useDisplayName.ts';
import { roleColorHex } from '../../utils/color.ts';

interface MentionBadgeProps {
  type: 'user' | 'role' | 'everyone';
  userId?: string;
  serverId?: string;
}

const EMPTY_MEMBERS: ReturnType<
  typeof useMemberStore.getState
>['byServer'][string] = [];
const EMPTY_ROLES: ReturnType<
  typeof useRoleStore.getState
>['byServer'][string] = [];

export function MentionBadge({ type, userId, serverId }: MentionBadgeProps) {
  const currentUserId = useAuthStore((s) => s.user?.id);

  const members = useMemberStore((s) =>
    serverId ? (s.byServer[serverId] ?? EMPTY_MEMBERS) : EMPTY_MEMBERS,
  );

  const roles = useRoleStore((s) =>
    serverId ? (s.byServer[serverId] ?? EMPTY_ROLES) : EMPTY_ROLES,
  );

  const displayName = useMemo(() => {
    if (type === 'everyone') return 'everyone';
    if (type === 'role') {
      if (!userId) return 'unknown role';
      const role = roles.find((r) => r.id === userId);
      return role?.name || userId.slice(0, 8);
    }
    if (!userId) return 'unknown';
    const member = members.find((m) => m.userId === userId);
    return member?.nickname || resolveDisplayName(userId, serverId);
  }, [type, userId, members, roles, serverId]);

  const roleColor = useMemo(() => {
    if (type !== 'role' || !userId) return undefined;
    const role = roles.find((r) => r.id === userId);
    return role?.color || undefined;
  }, [type, userId, roles]);

  // User mention color: resolve from highest role (server) or profile (DM)
  const userDisplayColor = useDisplayColor(
    type === 'user' ? (userId ?? '') : '',
    serverId,
  );

  const isCurrentUser = type === 'user' && userId === currentUserId;

  const colorHex = roleColor ? roleColorHex(roleColor) : undefined;

  // Determine effective mention color
  const mentionColor =
    type === 'role' ? colorHex : type === 'user' ? userDisplayColor : undefined;

  return (
    <span
      className={`rounded px-0.5 cursor-pointer ${
        isCurrentUser
          ? 'bg-accent/25 font-medium'
          : mentionColor
            ? 'font-medium'
            : 'bg-accent/15 text-accent'
      }`}
      style={
        mentionColor
          ? { backgroundColor: `${mentionColor}20`, color: mentionColor }
          : undefined
      }
    >
      @{displayName}
    </span>
  );
}
