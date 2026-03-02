import { useMemberStore, useRoleStore } from '@meza/core';
import { roleColorHex } from '../utils/color.ts';

const EMPTY_ROLE_IDS: readonly string[] = [];

/**
 * Resolve the display color for a user in a server context.
 *
 * Returns the highest-positioned role color, or undefined if no serverId
 * is provided or the user has no colored roles.
 */
export function useDisplayColor(
  userId: string,
  serverId: string | undefined,
): string | undefined {
  // Member's role IDs (server context only)
  const memberRoleIds = useMemberStore((s) => {
    if (!serverId) return EMPTY_ROLE_IDS;
    return (
      s.byServer[serverId]?.find((m) => m.userId === userId)?.roleIds ??
      EMPTY_ROLE_IDS
    );
  });

  // Highest-positioned role color (server context only)
  return useRoleStore((s) => {
    if (!serverId || !memberRoleIds.length) return undefined;
    const roles = s.byServer[serverId];
    if (!roles) return undefined;
    // roles are sorted by position descending — first with color wins
    for (const role of roles) {
      if (memberRoleIds.includes(role.id) && role.color) {
        return roleColorHex(role.color);
      }
    }
    return undefined;
  });
}
