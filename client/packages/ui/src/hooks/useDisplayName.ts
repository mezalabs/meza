import {
  getProfile,
  useAuthStore,
  useMemberStore,
  useUsersStore,
} from '@meza/core';
import { useEffect } from 'react';

/**
 * Resolve a user ID to a human-readable display name (non-hook version).
 *
 * Fallback chain:
 * 1. Member store nickname (already server-enriched: nickname → display_name → username)
 * 2. Auth store (current user's displayName or username)
 * 3. Users store (cached profile displayName or username)
 * 4. userId.slice(0, 8) (last resort)
 */
export function resolveDisplayName(userId: string, serverId?: string): string {
  if (serverId) {
    const members = useMemberStore.getState().byServer[serverId];
    const member = members?.find((m) => m.userId === userId);
    if (member?.nickname) return member.nickname;
  }

  const authUser = useAuthStore.getState().user;
  if (authUser?.id === userId) {
    return authUser.displayName || authUser.username;
  }

  const cached = useUsersStore.getState().profiles[userId];
  if (cached) {
    return cached.displayName || cached.username || userId.slice(0, 8);
  }

  return userId.slice(0, 8);
}

/** Track in-flight fetches so we don't fire duplicate requests. */
const fetchingProfiles = new Set<string>();

/**
 * React hook version of resolveDisplayName — subscribes to store changes.
 *
 * When no cached profile exists, triggers a background fetch so the
 * component re-renders with the real display name once it arrives.
 */
export function useDisplayName(userId: string, serverId?: string): string {
  const memberNickname = useMemberStore((s) => {
    if (!serverId) return undefined;
    const members = s.byServer[serverId];
    return members?.find((m) => m.userId === userId)?.nickname;
  });

  const authName = useAuthStore((s) => {
    if (s.user?.id !== userId) return undefined;
    return s.user.displayName || s.user.username;
  });

  const cachedName = useUsersStore((s) => {
    const profile = s.profiles[userId];
    if (!profile) return undefined;
    return profile.displayName || profile.username;
  });

  const resolved = memberNickname || authName || cachedName;

  // Lazily fetch the profile when it's not in any store yet.
  useEffect(() => {
    if (resolved || !userId || fetchingProfiles.has(userId)) return;
    fetchingProfiles.add(userId);
    getProfile(userId)
      .catch(() => {})
      .finally(() => fetchingProfiles.delete(userId));
  }, [userId, resolved]);

  return resolved || userId.slice(0, 8);
}
