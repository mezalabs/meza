import {
  createOrGetDMChannel,
  getMediaURL,
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
import { voiceConnect } from '../../hooks/useVoiceConnection.ts';
import { useNavigationStore } from '../../stores/navigation.ts';
import { useTilingStore } from '../../stores/tiling.ts';
import { openProfilePane } from '../../stores/tiling.ts';
import { Avatar } from '../shared/Avatar.tsx';
import { PresenceDot } from '../shared/PresenceDot.tsx';

const EMPTY_ARR: readonly never[] = [];

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
      <Popover.Trigger asChild onContextMenu={() => setOpen(false)}>
        {children}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="z-50 w-96 rounded-lg border border-border bg-bg-overlay shadow-lg data-[state=open]:animate-scale-in data-[state=closed]:animate-scale-out"
          side="top"
          align="center"
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

  const memberRoleIds = useMemberStore(
    (s) =>
      (serverId ? s.members?.[serverId]?.[userId]?.roleIds : undefined) ??
      EMPTY_ARR,
  );
  const serverRoles = useRoleStore(
    (s) => (serverId ? s.roles?.[serverId] : undefined) ?? EMPTY_ARR,
  );
  const memberRoles = serverRoles.filter((r) =>
    memberRoleIds.includes(r.id),
  );

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const fetchMutual = !isOwnProfile && !isBlocked;
      const [p, , va, ms] = await Promise.all([
        getProfile(userId),
        getPresence(userId).catch(() => {}),
        fetchMutual
          ? getUserVoiceActivity(userId).catch(() => [] as VoiceActivity[])
          : ([] as VoiceActivity[]),
        fetchMutual
          ? getMutualServers(userId).catch(() => [] as StoredServer[])
          : ([] as StoredServer[]),
      ]);
      setProfile(p);
      setVoiceActivity(va);
      setMutualServers(ms);
    } catch {
      // Profile fetch failed — keep whatever cached data we have
    } finally {
      setLoading(false);
    }
  }, [userId, isOwnProfile, isBlocked]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  if (loading && !profile) {
    return <ProfileCardSkeleton />;
  }

  if (!profile) return null;

  const navigateToServer = (sId: string) => {
    onClose();
    useNavigationStore.getState().selectServer(sId);
  };

  const joinVoiceChannel = (va: VoiceActivity) => {
    onClose();
    useNavigationStore.getState().selectServer(va.serverId);
    const { focusedPaneId, setPaneContent } = useTilingStore.getState();
    setPaneContent(focusedPaneId, { type: 'voice', channelId: va.channelId });
    voiceConnect(va.channelId, va.channelName);
  };

  return (
    <div className="flex flex-col">
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

      <div className="px-3 pt-2 pb-3">
        {/* Name + pronouns */}
        <div className="mb-1">
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

        {/* Roles — inline text, no pills */}
        {memberRoles.length > 0 && (
          <div className="flex items-center gap-1.5 text-xs text-text-muted mb-2">
            {memberRoles.map((role, i) => (
              <span key={role.id} className="flex items-center gap-1">
                <span
                  className="inline-block h-2 w-2 rounded-full flex-shrink-0"
                  style={{
                    backgroundColor: role.color
                      ? `#${role.color.toString(16).padStart(6, '0')}`
                      : undefined,
                  }}
                />
                {role.name}
                {i < memberRoles.length - 1 && (
                  <span className="text-text-subtle ml-0.5">&middot;</span>
                )}
              </span>
            ))}
          </div>
        )}

        {/* Voice activity — clickable to join */}
        {voiceActivity.length > 0 && (
          <div className="border-t border-border pt-2 mt-2">
            {voiceActivity.map((va) => (
              <button
                key={va.channelId}
                type="button"
                className="flex items-center gap-1.5 w-full text-left rounded px-1 py-1 -mx-1 hover:bg-bg-surface transition-colors"
                onClick={() => joinVoiceChannel(va)}
              >
                <svg
                  viewBox="0 0 16 16"
                  fill="currentColor"
                  className="h-3.5 w-3.5 text-success flex-shrink-0"
                >
                  <path d="M11.536 14.01A8.47 8.47 0 0 0 14.026 8a8.47 8.47 0 0 0-2.49-6.01l-.708.707A7.48 7.48 0 0 1 13.026 8c0 2.071-.84 3.946-2.198 5.303l.708.707z" />
                  <path d="M10.121 12.596A6.48 6.48 0 0 0 12.026 8a6.48 6.48 0 0 0-1.905-4.596l-.707.707A5.48 5.48 0 0 1 11.026 8a5.48 5.48 0 0 1-1.612 3.889l.707.707z" />
                  <path d="M8.707 11.182A4.49 4.49 0 0 0 10.026 8a4.49 4.49 0 0 0-1.319-3.182l-.707.707A3.49 3.49 0 0 1 9.026 8a3.49 3.49 0 0 1-1.026 2.475l.707.707z" />
                  <circle cx="4.026" cy="8" r="2" />
                </svg>
                <span className="text-xs text-text truncate">
                  {va.channelName}
                </span>
                <span className="text-xs text-text-subtle truncate">
                  in {va.serverName}
                </span>
                {va.isStreamingVideo && (
                  <span className="ml-auto text-[10px] font-medium text-accent flex-shrink-0">
                    LIVE
                  </span>
                )}
              </button>
            ))}
          </div>
        )}

        {/* Mutual servers — clickable list */}
        {!isOwnProfile && mutualServers.length > 0 && (
          <div className="border-t border-border pt-2 mt-2">
            <div className="text-[10px] uppercase tracking-wider text-text-subtle mb-1">
              {mutualServers.length} Mutual Server
              {mutualServers.length !== 1 ? 's' : ''}
            </div>
            <div className="flex flex-col">
              {mutualServers.slice(0, 5).map((s) => (
                <MutualServerRow
                  key={s.id}
                  server={s}
                  onNavigate={() => navigateToServer(s.id)}
                />
              ))}
              {mutualServers.length > 5 && (
                <span className="text-[10px] text-text-subtle px-1 pt-0.5">
                  +{mutualServers.length - 5} more
                </span>
              )}
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="border-t border-border pt-2 mt-2 flex items-center gap-1.5">
          {isOwnProfile ? (
            <button
              type="button"
              className="flex-1 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-black hover:bg-accent-hover transition-colors"
              onClick={() => {
                onClose();
                openProfilePane(userId);
              }}
            >
              Edit Profile
            </button>
          ) : (
            <>
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

              {!isBlocked && friendRelationship === 'none' && (
                <button
                  type="button"
                  className="flex-1 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-black hover:bg-accent-hover transition-colors"
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

function MutualServerRow({
  server,
  onNavigate,
}: {
  server: StoredServer;
  onNavigate: () => void;
}) {
  const memberCount = useMemberStore(
    (s) => s.byServer[server.id]?.length ?? 0,
  );

  return (
    <button
      type="button"
      className="flex items-center gap-2 rounded px-1 py-1 -mx-1 hover:bg-bg-surface transition-colors text-left"
      onClick={onNavigate}
    >
      {server.iconUrl ? (
        <img
          src={getMediaURL(server.iconUrl.replace(/^\/media\//, ''), false)}
          alt=""
          className="h-4 w-4 rounded-full object-cover flex-shrink-0"
        />
      ) : (
        <div className="flex h-4 w-4 items-center justify-center rounded-full bg-bg-elevated text-[8px] font-medium text-text-muted flex-shrink-0">
          {server.name.charAt(0).toUpperCase()}
        </div>
      )}
      <span className="text-xs text-text truncate">{server.name}</span>
      {memberCount > 0 && (
        <span className="flex items-center gap-0.5 text-[10px] text-text-subtle ml-auto flex-shrink-0">
          <svg
            viewBox="0 0 16 16"
            fill="currentColor"
            className="h-2.5 w-2.5"
          >
            <path d="M8 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm2-3a2 2 0 1 1-4 0 2 2 0 0 1 4 0zm4 8c0 1-1 1-1 1H3s-1 0-1-1 1-4 6-4 6 3 6 4zm-1-.004c-.001-.246-.154-.986-.832-1.664C11.516 10.68 10.289 10 8 10s-3.516.68-4.168 1.332c-.678.678-.83 1.418-.832 1.664h10z" />
          </svg>
          {memberCount}
        </span>
      )}
    </button>
  );
}

function ProfileCardBanner({ profile }: { profile: StoredUser }) {
  if (profile.themeColorPrimary) {
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
