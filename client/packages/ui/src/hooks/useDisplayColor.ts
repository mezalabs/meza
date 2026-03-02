import {
  useAuthStore,
  useMemberStore,
  useRoleStore,
  useUsersStore,
} from '@meza/core';
import { roleColorHex } from '../utils/color.ts';

const EMPTY_ROLE_IDS: readonly string[] = [];

/**
 * Resolve the display color for a user in a given context.
 *
 * - Server context (serverId defined): highest-positioned role with non-zero color
 * - DM context (serverId undefined): user's themeColorPrimary
 * - Fallback: undefined (caller uses default text color)
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
  const roleColor = useRoleStore((s) => {
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

  // Profile theme color (DM context only)
  const profileColor = useUsersStore((s) => {
    if (serverId) return undefined;
    return s.profiles[userId]?.themeColorPrimary || undefined;
  });

  const authColor = useAuthStore((s) => {
    if (serverId) return undefined;
    if (s.user?.id !== userId) return undefined;
    return s.user.themeColorPrimary || undefined;
  });

  if (serverId) return roleColor;
  const themeColor = profileColor || authColor;
  return themeColor ? `#${themeColor}` : undefined;
}
