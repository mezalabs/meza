import {
  createOrGetDMChannel,
  getPresence,
  getProfile,
  getMutualServers,
  getUserVoiceActivity,
  sendFriendRequest,
  type StoredServer,
  type StoredUser,
  type VoiceActivity,
  useAuthStore,
  useBlockStore,
  useFriendStore,
  useMemberStore,
  useRoleStore,
  useUsersStore,
} from '@meza/core';
import * as Popover from '@radix-ui/react-popover';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { useNavigationStore } from '../../stores/navigation.ts';
import { openProfilePane } from '../../stores/tiling.ts';
import { Avatar } from '../shared/Avatar.tsx';
import { PresenceDot } from '../shared/PresenceDot.tsx';

interface ProfilePopoverCardProps {
  userId: string;
  serverId?: string;
  children: ReactNode;
}

export function ProfilePopoverCard({
  userId,
  serverId,
  children,
}: ProfilePopoverCardProps) {
  const [open, setOpen] = useState(false);

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>{children}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="z-50 w-72 rounded-lg border border-border bg-bg-overlay shadow-lg data-[state=open]:animate-scale-in data-[state=closed]:animate-scale-out"
          side="right"
          align="start"
          sideOffset={8}
          collisionPadding={16}
        >
          {open && (
            <ProfileCardContent
              userId={userId}
              serverId={serverId}
              onClose={() => setOpen(false)}
            />
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function ProfileCardContent({
  userId,
  serverId,
  onClose,
}: {
  userId: string;
  serverId?: string;
  onClose: () => void;
}) {
  const currentUser = useAuthStore((s) => s.user);
  const cachedProfile = useUsersStore((s) => s.profiles[userId]);
  const [profile, setProfile] = useState<StoredUser | null>(
    cachedProfile ?? null,
  );
  const [loading, setLoading] = useState(!cachedProfile);
  const [voiceActivity, setVoiceActivity] = useState<VoiceActivity[]>([]);
  const [mutualServers, setMutualServers] = useState<StoredServer[]>([]);

  const isOwnProfile = currentUser?.id === userId;
  const isBlocked = useBlockStore((s) => s.isBlocked(userId));
  const friendRelationship = useFriendStore((s) => s.getRelationship(userId));

  // Get roles for this server
  const memberRoleIds = useMemberStore(
    (s) => (serverId ? s.members[serverId]?.[userId]?.roleIds : undefined) ?? [],
  );
  const serverRoles = useRoleStore(
    (s) => (serverId ? s.roles[serverId] : undefined) ?? [],
  );
  const memberRoles = serverRoles.filter((r) =>
    memberRoleIds.includes(r.id),
  );

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [p] = await Promise.all([
        getProfile(userId),
        getPresence(userId).catch(() => {}),
      ]);
      setProfile(p);

      // Fetch additional data in parallel (non-blocking)
      if (!isOwnProfile) {
        const [va, ms] = await Promise.all([
          getUserVoiceActivity(userId).catch(() => [] as VoiceActivity[]),
          getMutualServers(userId).catch(() => [] as StoredServer[]),
        ]);
        setVoiceActivity(va);
        setMutualServers(ms);
      }
    } catch {
      // Profile fetch failed — keep whatever cached data we have
    } finally {
      setLoading(false);
    }
  }, [userId, isOwnProfile]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  if (loading && !profile) {
    return <ProfileCardSkeleton />;
  }

  if (!profile) return null;

  return (
    <div className="flex flex-col">
      {/* Banner strip */}
      <ProfileCardBanner profile={profile} />

      {/* Avatar + identity */}
      <div className="px-3 -mt-5">
        <div className="relative inline-block">
          <Avatar
            avatarUrl={profile.avatarUrl}
            displayName={profile.displayName || profile.username}
            size="lg"
            className="ring-3 ring-bg-overlay"
          />
          <PresenceDot
            userId={userId}
            size="sm"
            className="absolute -bottom-0.5 -right-0.5 ring-2 ring-bg-overlay"
          />
        </div>
      </div>

      <div className="px-3 pt-2 pb-3 space-y-2">
        {/* Name + pronouns */}
        <div>
          <div className="flex items-baseline gap-1.5">
            <span className="text-sm font-semibold text-text truncate">
              {profile.displayName || profile.username}
            </span>
            {profile.pronouns && (
              <span className="text-xs text-text-muted flex-shrink-0">
                {profile.pronouns}
              </span>
            )}
          </div>
          <div className="text-xs text-text-subtle">@{profile.username}</div>
        </div>

        {/* Voice activity */}
        {voiceActivity.length > 0 && (
          <div className="rounded-md bg-bg-surface px-2 py-1.5">
            {voiceActivity.map((va) => (
              <div key={va.channelId} className="flex items-center gap-1.5">
                <span className="text-xs text-success">&#9679;</span>
                <span className="text-xs text-text truncate">
                  {va.channelName}
                </span>
                <span className="text-xs text-text-subtle">
                  in {va.serverName}
                </span>
                {va.isStreamingVideo && (
                  <span className="ml-auto text-[10px] font-medium text-accent bg-accent-subtle rounded px-1 py-0.5">
                    LIVE
                  </span>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Role pills */}
        {memberRoles.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {memberRoles.map((role) => (
              <span
                key={role.id}
                className="inline-flex items-center gap-1 rounded-full bg-bg-surface px-2 py-0.5 text-[10px] text-text-muted"
              >
                <span
                  className="h-2 w-2 rounded-full"
                  style={{
                    backgroundColor: role.color
                      ? `#${role.color.toString(16).padStart(6, '0')}`
                      : undefined,
                  }}
                />
                {role.name}
              </span>
            ))}
          </div>
        )}

        {/* Mutual servers (non-self) */}
        {!isOwnProfile && mutualServers.length > 0 && (
          <div className="text-xs text-text-subtle">
            {mutualServers.length} mutual server
            {mutualServers.length !== 1 ? 's' : ''}
          </div>
        )}

        {/* Divider */}
        <div className="h-px bg-border" />

        {/* Actions */}
        <div className="flex items-center gap-1.5">
          {isOwnProfile ? (
            <button
              type="button"
              className="flex-1 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-black hover:bg-accent-hover"
              onClick={() => {
                onClose();
                openProfilePane(userId);
              }}
            >
              Edit Profile
            </button>
          ) : (
            <>
              {/* DM button */}
              {!isBlocked && (
                <button
                  type="button"
                  className="flex-1 rounded-md bg-bg-surface px-3 py-1.5 text-xs font-medium text-text-muted hover:text-text transition-colors"
                  onClick={async () => {
                    try {
                      await createOrGetDMChannel(userId);
                      onClose();
                    } catch {}
                  }}
                >
                  Message
                </button>
              )}

              {/* Friend button */}
              {!isBlocked && friendRelationship === 'none' && (
                <button
                  type="button"
                  className="flex-1 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-black hover:bg-accent-hover"
                  onClick={async () => {
                    try {
                      await sendFriendRequest(userId);
                    } catch {}
                  }}
                >
                  Add Friend
                </button>
              )}
              {!isBlocked && friendRelationship === 'friends' && (
                <span className="flex-1 text-center text-xs text-text-subtle py-1.5">
                  Friends
                </span>
              )}
              {!isBlocked && friendRelationship === 'outgoing' && (
                <span className="flex-1 text-center text-xs text-text-subtle py-1.5">
                  Request Sent
                </span>
              )}
            </>
          )}

          {/* View Profile */}
          <button
            type="button"
            className="rounded-md bg-bg-surface px-3 py-1.5 text-xs font-medium text-text-muted hover:text-text transition-colors"
            onClick={() => {
              onClose();
              openProfilePane(userId);
            }}
          >
            Profile
          </button>
        </div>
      </div>
    </div>
  );
}

function ProfileCardBanner({ profile }: { profile: StoredUser }) {
  const hasThemeColors = !!profile.themeColorPrimary;

  if (hasThemeColors) {
    return (
      <div
        className="h-14 w-full rounded-t-lg"
        style={{
          background: `linear-gradient(135deg, #${profile.themeColorPrimary}, #${profile.themeColorSecondary || profile.themeColorPrimary})`,
        }}
      />
    );
  }

  return <div className="h-14 w-full rounded-t-lg bg-bg-surface" />;
}

function ProfileCardSkeleton() {
  return (
    <div className="flex flex-col animate-pulse">
      <div className="h-14 w-full rounded-t-lg bg-bg-surface" />
      <div className="px-3 -mt-5">
        <div className="h-8 w-8 rounded-full bg-bg-elevated ring-3 ring-bg-overlay" />
      </div>
      <div className="px-3 pt-2 pb-3 space-y-2">
        <div className="h-4 w-28 rounded bg-bg-surface" />
        <div className="h-3 w-20 rounded bg-bg-surface" />
        <div className="h-px bg-border" />
        <div className="h-7 w-full rounded bg-bg-surface" />
      </div>
    </div>
  );
}
