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
    if (!serverId || !userId) return EMPTY_ROLE_IDS;
    return (
      s.byServer[serverId]?.find((m) => m.userId === userId)?.roleIds ??
      EMPTY_ROLE_IDS
    );
  });

  // Server roles (sorted by position descending)
  const roles = useRoleStore((s) =>
    serverId ? s.byServer[serverId] : undefined,
  );

  // Derive color in render body — both values are guaranteed fresh,
  // avoiding stale closures from cross-store selector dependencies.
  if (!serverId || !memberRoleIds.length || !roles) return undefined;
  for (const role of roles) {
    if (memberRoleIds.includes(role.id) && role.color) {
      return roleColorHex(role.color);
    }
  }
  return undefined;
}
