import {
  createOrGetDMChannel,
  getMediaURL,
  getMutualServers,
  getPresence,
  getProfile,
  getUserVoiceActivity,
  type StoredServer,
  type StoredUser,
  sendFriendRequest,
  useAuthStore,
  useBlockStore,
  useFriendStore,
  useMemberStore,
  useRoleStore,
  useUsersStore,
  type VoiceActivity,
} from '@meza/core';
import {
  ChatCircleIcon,
  SpeakerHighIcon,
  UserIcon,
  UserPlusIcon,
} from '@phosphor-icons/react';
import * as Popover from '@radix-ui/react-popover';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useDisplayColor } from '../../hooks/useDisplayColor.ts';
import { useMobile } from '../../hooks/useMobile.ts';
import { voiceConnect } from '../../hooks/useVoiceConnection.ts';
import { useNavigationStore } from '../../stores/navigation.ts';
import { openProfilePane, useTilingStore } from '../../stores/tiling.ts';
import { roleColorHex } from '../../utils/color.ts';
import { Avatar } from '../shared/Avatar.tsx';
import { PresenceDot } from '../shared/PresenceDot.tsx';

const EMPTY_STRINGS: readonly string[] = [];
const EMPTY_ROLES: readonly {
  id: string;
  name: string;
  color: number;
  position: number;
}[] = [];

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
          className="z-50 w-72 md:w-96 rounded-lg border border-border bg-bg-overlay shadow-lg data-[state=open]:animate-scale-in data-[state=closed]:animate-scale-out"
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
  const isMobile = useMobile();
  const currentUser = useAuthStore((s) => s.user);
  const displayColor = useDisplayColor(userId, serverId);
  const cachedProfile = useUsersStore((s) => s.profiles[userId]);
  const [profile, setProfile] = useState<StoredUser | null>(
    cachedProfile ?? null,
  );
  const [loading, setLoading] = useState(!cachedProfile);
  const [voiceActivity, setVoiceActivity] = useState<VoiceActivity[]>([]);
  const [mutualServers, setMutualServers] = useState<StoredServer[]>([]);
  const [actionError, setActionError] = useState('');

  const isOwnProfile = currentUser?.id === userId;
  const isBlocked = useBlockStore((s) => s.isBlocked(userId));
  const friendRelationship = useFriendStore((s) => s.getRelationship(userId));

  const memberRoleIds = useMemberStore(
    (s) =>
      (serverId
        ? s.byServer[serverId]?.find((m) => m.userId === userId)?.roleIds
        : undefined) ?? EMPTY_STRINGS,
  );
  const serverRoles = useRoleStore(
    (s) => (serverId ? s.byServer[serverId] : undefined) ?? EMPTY_ROLES,
  );
  const memberRoles = serverRoles.filter((r) => memberRoleIds.includes(r.id));

  // Track the userId that initiated the fetch so we can discard stale results.
  const fetchIdRef = useRef(0);

  useEffect(() => {
    const id = ++fetchIdRef.current;

    // If cached profile is fresh (<30s old), skip the network fetch.
    // Voice activity and mutual servers are always refetched (ephemeral).
    const fresh = useUsersStore.getState().isProfileFresh(userId, 30_000);
    const profilePromise =
      fresh && cachedProfile
        ? Promise.resolve(cachedProfile)
        : getProfile(userId);

    if (!fresh) setLoading(true);

    const fetchMutual = !isOwnProfile && !isBlocked;
    Promise.all([
      profilePromise,
      getPresence(userId).catch(() => {}),
      fetchMutual
        ? getUserVoiceActivity(userId).catch(() => [] as VoiceActivity[])
        : ([] as VoiceActivity[]),
      fetchMutual
        ? getMutualServers(userId).catch(() => [] as StoredServer[])
        : ([] as StoredServer[]),
    ])
      .then(([p, , va, ms]) => {
        if (id !== fetchIdRef.current) return; // stale — discard
        setProfile(p);
        setVoiceActivity(va);
        setMutualServers(ms);
      })
      .catch(() => {
        // Profile fetch failed — keep whatever cached data we have
      })
      .finally(() => {
        if (id !== fetchIdRef.current) return;
        setLoading(false);
      });

    return () => {
      // Bump the counter so any in-flight fetch is discarded on cleanup.
      fetchIdRef.current++;
    };
  }, [userId, isOwnProfile, isBlocked, cachedProfile]);

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
            <span
              className="text-base font-semibold text-text truncate"
              style={displayColor ? { color: displayColor } : undefined}
            >
              {profile.displayName || profile.username}
            </span>
            {profile.pronouns && (
              <span className="text-sm text-text-muted flex-shrink-0">
                {profile.pronouns}
              </span>
            )}
          </div>
          <div className="text-sm text-text-subtle">@{profile.username}</div>
        </div>

        {/* Roles — inline text, no pills */}
        {memberRoles.length > 0 && (
          <div className="flex items-center gap-1.5 text-sm text-text-muted mb-2">
            {memberRoles.map((role, i) => (
              <span key={role.id} className="flex items-center gap-1">
                <span
                  className="inline-block h-2 w-2 rounded-full flex-shrink-0"
                  style={{
                    backgroundColor: roleColorHex(role.color),
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
                <SpeakerHighIcon
                  size={14}
                  weight="fill"
                  className="text-success flex-shrink-0"
                  aria-hidden="true"
                />
                <span className="text-sm text-text truncate">
                  {va.channelName}
                </span>
                <span className="text-sm text-text-subtle truncate">
                  in {va.serverName}
                </span>
                {va.isStreamingVideo && (
                  <span className="ml-auto text-xs font-medium text-accent flex-shrink-0">
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
            <div className="text-xs uppercase tracking-wider text-text-subtle mb-1">
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
                <span className="text-xs text-text-subtle px-1 pt-0.5">
                  +{mutualServers.length - 5} more
                </span>
              )}
            </div>
          </div>
        )}

        {/* Action error */}
        {actionError && (
          <div className="text-xs text-error mt-2">{actionError}</div>
        )}

        {/* Actions */}
        <div className="border-t border-border pt-2 mt-2 flex items-center gap-1.5">
          {isOwnProfile ? (
            <button
              type="button"
              className="flex-1 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-black hover:bg-accent-hover transition-colors"
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
                  className="flex-1 flex items-center justify-center gap-1.5 rounded-md bg-bg-surface px-3 py-1.5 text-sm font-medium text-text-muted hover:text-text transition-colors"
                  onClick={async () => {
                    try {
                      await createOrGetDMChannel(userId);
                      onClose();
                    } catch {
                      setActionError('Failed to open conversation');
                    }
                  }}
                >
                  {isMobile ? (
                    <ChatCircleIcon
                      size={18}
                      weight="fill"
                      aria-label="Message"
                    />
                  ) : (
                    'Message'
                  )}
                </button>
              )}

              {!isBlocked && friendRelationship === 'none' && (
                <button
                  type="button"
                  className="flex-1 flex items-center justify-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-black hover:bg-accent-hover transition-colors"
                  onClick={async () => {
                    try {
                      await sendFriendRequest(userId);
                    } catch {
                      setActionError('Failed to send friend request');
                    }
                  }}
                >
                  {isMobile ? (
                    <UserPlusIcon
                      size={18}
                      weight="fill"
                      aria-label="Add Friend"
                    />
                  ) : (
                    'Add Friend'
                  )}
                </button>
              )}
              {!isBlocked && friendRelationship === 'friends' && (
                <span className="flex-1 text-center text-sm text-text-subtle py-1.5">
                  Friends
                </span>
              )}
              {!isBlocked && friendRelationship === 'outgoing' && (
                <span className="flex-1 text-center text-sm text-text-subtle py-1.5">
                  Request Sent
                </span>
              )}
            </>
          )}

          <button
            type="button"
            className="flex items-center justify-center rounded-md bg-bg-surface px-3 py-1.5 text-sm font-medium text-text-muted hover:text-text transition-colors"
            onClick={() => {
              onClose();
              openProfilePane(userId);
            }}
          >
            {isMobile ? (
              <UserIcon size={18} weight="fill" aria-label="Profile" />
            ) : (
              'Profile'
            )}
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
  const memberCount = useMemberStore((s) => s.byServer[server.id]?.length ?? 0);

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
          className="h-5 w-5 rounded-full object-cover flex-shrink-0"
        />
      ) : (
        <div className="flex h-5 w-5 items-center justify-center rounded-full bg-bg-elevated text-[9px] font-medium text-text-muted flex-shrink-0">
          {server.name.charAt(0).toUpperCase()}
        </div>
      )}
      <span className="text-sm text-text truncate">{server.name}</span>
      {memberCount > 0 && (
        <span className="flex items-center gap-0.5 text-xs text-text-subtle ml-auto flex-shrink-0">
          <UserIcon size={12} aria-hidden="true" />
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
