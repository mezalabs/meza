import {
  listMembers,
  listRoles,
  useAuthStore,
  useMemberStore,
  useRoleStore,
  useUsersStore,
} from '@meza/core';
import { useEffect, useMemo } from 'react';
import { useDisplayColor } from '../../hooks/useDisplayColor.ts';
import { resolveDisplayName } from '../../hooks/useDisplayName.ts';
import { roleColorHex } from '../../utils/color.ts';
import { BotBadge } from '../common/BotBadge.tsx';
import { Avatar } from '../shared/Avatar.tsx';
import { PresenceDot } from '../shared/PresenceDot.tsx';
import { UserProfileTrigger } from '../shared/UserProfileTrigger.tsx';
import { MemberContextMenu } from './MemberContextMenu.tsx';

const EMPTY_MEMBERS: never[] = [];
const EMPTY_ROLES: never[] = [];

interface MemberListProps {
  serverId: string;
}

interface RoleGroup {
  roleId: string | null;
  roleName: string;
  roleColor: number;
  rolePosition: number;
  members: {
    userId: string;
    displayName: string;
    avatarUrl?: string;
    isBot?: boolean;
  }[];
}

export function MemberList({ serverId }: MemberListProps) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const members = useMemberStore((s) => s.byServer[serverId] ?? EMPTY_MEMBERS);
  const roles = useRoleStore((s) => s.byServer[serverId] ?? EMPTY_ROLES);
  const profiles = useUsersStore((s) => s.profiles);

  useEffect(() => {
    if (!isAuthenticated || !serverId) return;
    listMembers(serverId, { limit: 200 })
      .then((result) => {
        useMemberStore.getState().setMembers(serverId, result);
      })
      .catch(() => {});
    listRoles(serverId).catch(() => {});
  }, [serverId, isAuthenticated]);

  const groups = useMemo(() => {
    const roleMap = new Map(roles.map((r) => [r.id, r]));
    const groupMap = new Map<string | null, RoleGroup>();

    for (const member of members) {
      // Find highest-position role for this member
      let highestRole: {
        id: string;
        name: string;
        color: number;
        position: number;
      } | null = null;
      for (const roleId of member.roleIds) {
        const role = roleMap.get(roleId);
        if (role && (!highestRole || role.position > highestRole.position)) {
          highestRole = role;
        }
      }

      const groupKey = highestRole?.id ?? null;
      let group = groupMap.get(groupKey);
      if (!group) {
        group = {
          roleId: groupKey,
          roleName: highestRole?.name ?? 'Members',
          roleColor: highestRole?.color ?? 0,
          rolePosition: highestRole?.position ?? -1,
          members: [],
        };
        groupMap.set(groupKey, group);
      }

      group.members.push({
        userId: member.userId,
        displayName:
          member.nickname || resolveDisplayName(member.userId, serverId),
        avatarUrl: profiles[member.userId]?.avatarUrl,
        isBot: profiles[member.userId]?.isBot,
      });
    }

    // Sort groups by role position descending, "Members" (no role) last
    const sorted = Array.from(groupMap.values()).sort(
      (a, b) => b.rolePosition - a.rolePosition,
    );

    // Separate bot members into their own group
    const botMembers: RoleGroup['members'] = [];
    for (const group of sorted) {
      const bots = group.members.filter((m) => m.isBot);
      if (bots.length > 0) {
        botMembers.push(...bots);
        group.members = group.members.filter((m) => !m.isBot);
      }
    }

    // Remove groups that became empty after extracting bots
    const filtered = sorted.filter((g) => g.members.length > 0);

    return { roleGroups: filtered, botMembers };
  }, [members, roles, serverId, profiles]);

  if (members.length === 0) {
    return <div className="p-3 text-xs text-text-subtle">No members</div>;
  }

  const { roleGroups, botMembers } = groups;

  return (
    <div className="flex flex-col gap-3 overflow-y-auto p-3">
      {roleGroups.map((group) => (
        <div key={group.roleId ?? '__none'}>
          <div className="mb-1 flex items-center gap-1.5">
            {group.roleColor !== 0 && (
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{
                  backgroundColor: roleColorHex(group.roleColor),
                }}
              />
            )}
            <h3 className="text-xs font-semibold uppercase tracking-wider text-text-subtle">
              {group.roleName} &mdash; {group.members.length}
            </h3>
          </div>
          {group.members.map((m) => (
            <MemberRow
              key={m.userId}
              serverId={serverId}
              userId={m.userId}
              displayName={m.displayName}
              avatarUrl={m.avatarUrl}
              isBot={m.isBot}
            />
          ))}
        </div>
      ))}
      {botMembers.length > 0 && (
        <div>
          <div className="mb-1 flex items-center gap-1.5">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-text-subtle">
              Bots &mdash; {botMembers.length}
            </h3>
          </div>
          {botMembers.map((m) => (
            <MemberRow
              key={m.userId}
              serverId={serverId}
              userId={m.userId}
              displayName={m.displayName}
              avatarUrl={m.avatarUrl}
              isBot
            />
          ))}
        </div>
      )}
    </div>
  );
}

function MemberRow({
  serverId,
  userId,
  displayName,
  avatarUrl,
  isBot,
}: {
  serverId: string;
  userId: string;
  displayName: string;
  avatarUrl?: string;
  isBot?: boolean;
}) {
  const displayColor = useDisplayColor(userId, serverId);
  return (
    <MemberContextMenu
      serverId={serverId}
      userId={userId}
      displayName={displayName}
    >
      <UserProfileTrigger userId={userId} serverId={serverId}>
        <div className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 hover:bg-bg-surface">
          <div className="relative">
            <Avatar avatarUrl={avatarUrl} displayName={displayName} size="md" />
            <PresenceDot
              userId={userId}
              size="sm"
              className="absolute -bottom-0.5 -right-0.5 ring-2 ring-bg-overlay"
            />
          </div>
          <span
            className="truncate text-sm text-text"
            style={displayColor ? { color: displayColor } : undefined}
          >
            {displayName}
          </span>
          {isBot && <BotBadge />}
        </div>
      </UserProfileTrigger>
    </MemberContextMenu>
  );
}
