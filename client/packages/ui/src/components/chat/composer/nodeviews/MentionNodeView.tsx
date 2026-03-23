import { useAuthStore, useMemberStore, useRoleStore } from '@meza/core';
import { useNodeViewContext } from '@prosemirror-adapter/react';
import { memo, useMemo } from 'react';
import { resolveDisplayName } from '../../../../hooks/useDisplayName.ts';
import { roleColorHex } from '../../../../utils/color.ts';
import type { MentionAttrs } from '../schema';

const MentionNodeView = memo(function MentionNodeView() {
  const { node, selected } = useNodeViewContext();
  const { id, type } = node.attrs as MentionAttrs;

  const currentUserId = useAuthStore((s) => s.user?.id);

  const displayName = useMemberStore((s) => {
    if (type === 'everyone') return 'everyone';

    if (type === 'role') {
      // Roles are looked up via useRoleStore below
      return null;
    }

    // user: scan byServer entries to find member by userId
    for (const members of Object.values(s.byServer)) {
      const member = members.find((m) => m.userId === id);
      if (member?.nickname) return member.nickname;
    }
    return null;
  });

  const roleInfo = useRoleStore((s) => {
    if (type !== 'role') return undefined;
    for (const roles of Object.values(s.byServer)) {
      const role = roles.find((r) => r.id === id);
      if (role) return { name: role.name, color: role.color };
    }
    return undefined;
  });

  const label = useMemo(() => {
    if (type === 'everyone') return 'everyone';
    if (type === 'role') return roleInfo?.name || id.slice(0, 8);
    return displayName || resolveDisplayName(id);
  }, [type, id, displayName, roleInfo]);

  const isCurrentUser = type === 'user' && id === currentUserId;
  const colorHex =
    type === 'role' ? roleColorHex(roleInfo?.color ?? 0) : undefined;

  return (
    <span
      className={`inline-block rounded px-0.5 ${
        selected ? 'ring-2 ring-accent/50' : ''
      } ${
        isCurrentUser
          ? 'bg-accent/25 text-accent font-medium'
          : colorHex
            ? 'font-medium'
            : 'bg-accent/15 text-accent'
      }`}
      style={
        !isCurrentUser && colorHex
          ? { backgroundColor: `${colorHex}20`, color: colorHex }
          : undefined
      }
      contentEditable={false}
    >
      {'\u200B'}
      <span style={{ display: 'inline-block' }}>@{label}</span>
      {'\u200B'}
    </span>
  );
});

export { MentionNodeView };
