import {
  listMembers,
  listRoles,
  useAuthStore,
  useMemberStore,
  useRoleStore,
  useUsersStore,
} from '@meza/core';
import { useEffect, useMemo } from 'react';
import { resolveDisplayName } from '../../hooks/useDisplayName.ts';
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
  members: { userId: string; displayName: string; avatarUrl?: string }[];
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
      });
    }

    // Sort groups by role position descending, "Members" (no role) last
    return Array.from(groupMap.values()).sort(
      (a, b) => b.rolePosition - a.rolePosition,
    );
  }, [members, roles, serverId, profiles]);

  if (members.length === 0) {
    return <div className="p-3 text-xs text-text-subtle">No members</div>;
  }

  return (
    <div className="flex flex-col gap-3 overflow-y-auto p-3">
      {groups.map((group) => (
        <div key={group.roleId ?? '__none'}>
          <div className="mb-1 flex items-center gap-1.5">
            {group.roleColor !== 0 && (
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{
                  backgroundColor: `#${group.roleColor.toString(16).padStart(6, '0')}`,
                }}
              />
            )}
            <h3 className="text-xs font-semibold uppercase tracking-wider text-text-subtle">
              {group.roleName} &mdash; {group.members.length}
            </h3>
          </div>
          {group.members.map((m) => (
            <MemberContextMenu
              key={m.userId}
              serverId={serverId}
              userId={m.userId}
              displayName={m.displayName}
            >
              <UserProfileTrigger userId={m.userId} serverId={serverId}>
                <div className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 hover:bg-bg-surface">
                  <div className="relative">
                    <Avatar
                      avatarUrl={m.avatarUrl}
                      displayName={m.displayName}
                      size="md"
                    />
                    <PresenceDot
                      userId={m.userId}
                      size="sm"
                      className="absolute -bottom-0.5 -right-0.5 ring-2 ring-bg-overlay"
                    />
                  </div>
                  <span className="truncate text-sm text-text">
                    {m.displayName}
                  </span>
                </div>
              </UserProfileTrigger>
            </MemberContextMenu>
          ))}
        </div>
      ))}
    </div>
  );
}
