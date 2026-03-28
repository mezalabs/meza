import {
  createOrGetDMChannel,
  hasPermission,
  Permissions,
  setMemberRoles,
  useAuthStore,
  useMemberStore,
  useRoleStore,
  useServerStore,
} from '@meza/core';
import * as ContextMenu from '@radix-ui/react-context-menu';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigationStore } from '../../stores/navigation.ts';
import { openProfilePane, useTilingStore } from '../../stores/tiling.ts';
import { roleColorHex } from '../../utils/color.ts';

const EMPTY_ROLES: never[] = [];

import { BanMemberDialog } from './BanMemberDialog.tsx';
import { KickMemberDialog } from './KickMemberDialog.tsx';

interface MemberContextMenuProps {
  serverId: string;
  userId: string;
  displayName: string;
  children: ReactNode;
}

export function MemberContextMenu({
  serverId,
  userId,
  displayName,
  children,
}: MemberContextMenuProps) {
  const [kickOpen, setKickOpen] = useState(false);
  const [banOpen, setBanOpen] = useState(false);
  const [pendingAdds, setPendingAdds] = useState<Set<string>>(new Set());
  const [pendingRemoves, setPendingRemoves] = useState<Set<string>>(new Set());
  const [isSubmitting, setIsSubmitting] = useState(false);

  const currentUserId = useAuthStore((s) => s.user?.id);
  const ownerId = useServerStore((s) => s.servers[serverId]?.ownerId);
  const currentMember = useMemberStore((s) =>
    s.byServer[serverId]?.find((m) => m.userId === currentUserId),
  );
  const targetMember = useMemberStore((s) =>
    s.byServer[serverId]?.find((m) => m.userId === userId),
  );
  const roles = useRoleStore((s) => s.byServer[serverId] ?? EMPTY_ROLES);

  const roleMap = useMemo(() => {
    const map = new Map<string, (typeof roles)[number]>();
    for (const role of roles) map.set(role.id, role);
    return map;
  }, [roles]);

  const myPermissions = useMemo(() => {
    if (!currentMember) return 0n;
    // Server owner has all permissions
    if (currentUserId === ownerId) return ~0n;
    let combined = 0n;
    for (const roleId of currentMember.roleIds) {
      const role = roleMap.get(roleId);
      if (role) combined |= role.permissions;
    }
    return combined;
  }, [currentMember, currentUserId, ownerId, roleMap]);

  const myMaxPosition = useMemo(() => {
    if (currentUserId === ownerId) return Infinity;
    let maxPos = 0;
    for (const roleId of currentMember?.roleIds ?? []) {
      const role = roleMap.get(roleId);
      if (role && role.position > maxPos) maxPos = role.position;
    }
    return maxPos;
  }, [currentMember, currentUserId, ownerId, roleMap]);

  const assignableRoles = useMemo(
    () => roles.filter((r) => r.position < myMaxPosition),
    [roles, myMaxPosition],
  );

  const displayedRoleIds = useMemo(() => {
    const base = new Set(targetMember?.roleIds ?? []);
    for (const id of pendingAdds) base.add(id);
    for (const id of pendingRemoves) base.delete(id);
    return base;
  }, [targetMember?.roleIds, pendingAdds, pendingRemoves]);

  // Clear pending state when the gateway event confirms the change
  const prevRoleIdsRef = useRef(targetMember?.roleIds);
  useEffect(() => {
    const prev = prevRoleIdsRef.current;
    const curr = targetMember?.roleIds;
    prevRoleIdsRef.current = curr;
    if (prev !== curr) {
      setPendingAdds(new Set());
      setPendingRemoves(new Set());
    }
  }, [targetMember?.roleIds]);

  const selectDMs = useNavigationStore((s) => s.selectDMs);
  const focusedPaneId = useTilingStore((s) => s.focusedPaneId);
  const setPaneContent = useTilingStore((s) => s.setPaneContent);

  const isSelf = userId === currentUserId;
  const isOwner = userId === ownerId;

  const canKick =
    !isSelf &&
    !isOwner &&
    hasPermission(myPermissions, Permissions.KICK_MEMBERS);
  const canBan =
    !isSelf &&
    !isOwner &&
    hasPermission(myPermissions, Permissions.BAN_MEMBERS);
  const canManageRoles = hasPermission(myPermissions, Permissions.MANAGE_ROLES);
  const canAssignRolesToTarget =
    canManageRoles &&
    assignableRoles.length > 0 &&
    (isSelf ? currentUserId === ownerId : !isOwner);

  async function handleRoleToggle(roleId: string) {
    if (isSubmitting) return;
    // Read fresh from store to avoid stale closures
    const current = useMemberStore
      .getState()
      .byServer[serverId]?.find((m) => m.userId === userId);
    if (!current) return;

    const currentSet = new Set(current.roleIds);
    const adding = !currentSet.has(roleId);
    if (adding) currentSet.add(roleId);
    else currentSet.delete(roleId);

    // Update local pending state for immediate visual feedback
    if (adding) {
      setPendingAdds((s) => new Set(s).add(roleId));
    } else {
      setPendingRemoves((s) => new Set(s).add(roleId));
    }

    setIsSubmitting(true);
    try {
      await setMemberRoles(serverId, userId, Array.from(currentSet));
    } catch {
      // Clear pending on error — checkboxes snap to server truth
      setPendingAdds(new Set());
      setPendingRemoves(new Set());
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <>
      <ContextMenu.Root>
        <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content className="min-w-[180px] rounded-lg bg-bg-elevated p-1 shadow-lg animate-scale-in">
            <ContextMenu.Item
              className="cursor-default rounded-md px-3 py-1.5 text-sm text-text outline-none data-[highlighted]:bg-accent-subtle"
              onSelect={() => openProfilePane(userId)}
            >
              View Profile
            </ContextMenu.Item>

            {!isSelf && (
              <ContextMenu.Item
                className="cursor-default rounded-md px-3 py-1.5 text-sm text-text outline-none data-[highlighted]:bg-accent-subtle"
                onSelect={() => {
                  createOrGetDMChannel(userId)
                    .then((res) => {
                      const channelId = res.dmChannel?.channel?.id;
                      if (channelId) {
                        selectDMs();
                        setPaneContent(focusedPaneId, {
                          type: 'dm',
                          conversationId: channelId,
                        });
                      }
                    })
                    .catch(() => {});
                }}
              >
                Message
              </ContextMenu.Item>
            )}

            {canAssignRolesToTarget && (
              <>
                <ContextMenu.Separator className="my-1 h-px bg-border" />
                <ContextMenu.Sub>
                  <ContextMenu.SubTrigger className="cursor-default rounded-md px-3 py-1.5 text-sm text-text outline-none data-[highlighted]:bg-accent-subtle data-[state=open]:bg-accent-subtle">
                    Manage Roles
                  </ContextMenu.SubTrigger>
                  <ContextMenu.Portal>
                    <ContextMenu.SubContent className="min-w-[180px] rounded-lg bg-bg-elevated p-1 shadow-lg animate-scale-in">
                      {assignableRoles.map((role) => (
                        <ContextMenu.CheckboxItem
                          key={role.id}
                          className="cursor-default rounded-md px-3 py-1.5 text-sm text-text outline-none data-[highlighted]:bg-accent-subtle"
                          checked={displayedRoleIds.has(role.id)}
                          onSelect={(e) => e.preventDefault()}
                          onCheckedChange={() => handleRoleToggle(role.id)}
                        >
                          <div className="flex items-center gap-2">
                            <span
                              className="inline-block h-3 w-3 shrink-0 rounded-full"
                              style={{
                                backgroundColor: roleColorHex(role.color),
                              }}
                            />
                            <span className="truncate">{role.name}</span>
                          </div>
                        </ContextMenu.CheckboxItem>
                      ))}
                    </ContextMenu.SubContent>
                  </ContextMenu.Portal>
                </ContextMenu.Sub>
              </>
            )}

            {(canKick || canBan) && (
              <>
                <ContextMenu.Separator className="my-1 h-px bg-border" />
                {canKick && (
                  <ContextMenu.Item
                    className="cursor-default rounded-md px-3 py-1.5 text-sm text-error outline-none data-[highlighted]:bg-error/10"
                    onSelect={() => setKickOpen(true)}
                  >
                    Kick Member
                  </ContextMenu.Item>
                )}
                {canBan && (
                  <ContextMenu.Item
                    className="cursor-default rounded-md px-3 py-1.5 text-sm text-error outline-none data-[highlighted]:bg-error/10"
                    onSelect={() => setBanOpen(true)}
                  >
                    Ban Member
                  </ContextMenu.Item>
                )}
              </>
            )}
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu.Root>

      <KickMemberDialog
        serverId={serverId}
        userId={userId}
        displayName={displayName}
        open={kickOpen}
        onOpenChange={setKickOpen}
      />
      <BanMemberDialog
        serverId={serverId}
        userId={userId}
        displayName={displayName}
        open={banOpen}
        onOpenChange={setBanOpen}
      />
    </>
  );
}
