import { useDraggable } from '@dnd-kit/core';
import { useIsSpeaking, useMaybeRoomContext } from '@livekit/components-react';
import type { DMChannel, PaneContent } from '@meza/core';
import {
  ChannelType,
  createChannelGroup,
  getBulkPresence,
  getDMDisplayName,
  getNotificationPreferences,
  isGroupDM,
  isSelfDM,
  listChannelGroups,
  listChannels,
  listDMChannels,
  listFriendRequests,
  listFriends,
  listMembers,
  listMessageRequests,
  listServers,
  Permissions,
  resolveIconUrl,
  resolveMediaUrl,
  soundManager,
  updateNotificationPreference,
  useAuthStore,
  useChannelGroupStore,
  useChannelStore,
  useDMStore,
  useFederationStore,
  useFriendStore,
  useGatewayStore,
  useInviteStore,
  useMemberStore,
  useNotificationSettingsStore,
  useReadStateStore,
  useRoleStore,
  useServerStore,
  useUsersStore,
  useVoiceParticipantsStore,
  useVoiceStore,
} from '@meza/core';
import {
  ArrowRightIcon,
  BellSimpleIcon,
  BellSimpleSlashIcon,
  CaretDownIcon,
  CaretRightIcon,
  EarSlashIcon,
  GearIcon,
  HashIcon,
  LinkBreakIcon,
  LockSimpleIcon,
  MicrophoneIcon,
  MicrophoneSlashIcon,
  PlusIcon,
  ScrollIcon,
  SpeakerHighIcon,
  UserPlusIcon,
  UsersThreeIcon,
  VideoCameraIcon,
} from '@phosphor-icons/react';
import * as Popover from '@radix-ui/react-popover';
import { ParticipantEvent } from 'livekit-client';
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useDisplayName } from '../../hooks/useDisplayName.ts';
import { useLocalSpeaking } from '../../hooks/useLocalSpeaking.ts';
import { useMobile } from '../../hooks/useMobile.ts';
import { useVoiceChannelParticipants } from '../../hooks/useVoiceChannelParticipants.ts';
import { useVoiceConnection } from '../../hooks/useVoiceConnection.ts';
import { useNavigationStore } from '../../stores/navigation.ts';
import {
  openCategoryPermissionsPane,
  openChannelSettingsPane,
  openProfilePane,
  useTilingStore,
} from '../../stores/tiling.ts';
import { CreateGroupDMDialog } from '../dm/CreateGroupDMDialog.tsx';
import { Avatar } from '../shared/Avatar.tsx';
import { MezaIcon } from '../shared/MezaIcon.tsx';
import { PresenceDot } from '../shared/PresenceDot.tsx';
import { MobileVoiceBar } from '../voice/MobileVoiceBar.tsx';
import {
  StreamPreviewTrackProvider,
  StreamPreviewTrigger,
} from '../voice/StreamPreviewHoverCard.tsx';
import { VoiceConnectionBar } from '../voice/VoiceConnectionBar.tsx';
import { CreateChannelDialog } from './CreateChannelDialog.tsx';
import { CreateServerDialog } from './CreateServerDialog.tsx';
import { InviteDialog } from './InviteDialog.tsx';
import { JoinServerDialog } from './JoinServerDialog.tsx';
import { SidebarContextMenu } from './SidebarContextMenu.tsx';
import { StatusPicker } from './StatusPicker.tsx';

const EMPTY_CHANNELS: {
  id: string;
  name: string;
  type: ChannelType;
  isPrivate: boolean;
  channelGroupId?: string;
  voiceTextChannelId?: string;
}[] = [];

const EMPTY_GROUPS: { id: string; name: string; position: number }[] = [];
const EMPTY_ARR: readonly never[] = [];

export function Sidebar({ style }: { style?: React.CSSProperties }) {
  const isMobile = useMobile();
  const servers = useServerStore((s) => s.servers);
  const serversLoading = useServerStore((s) => s.isLoading);
  const channelsLoading = useChannelStore((s) => s.isLoading);
  const selectedServerId = useNavigationStore((s) => s.selectedServerId);
  const isFederatedServer = useFederationStore(
    (s) => !!(selectedServerId && s.serverIndex[selectedServerId]),
  );
  const showDMs = useNavigationStore((s) => s.showDMs);
  const selectServer = useNavigationStore((s) => s.selectServer);
  const selectDMs = useNavigationStore((s) => s.selectDMs);

  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const reconnectCount = useGatewayStore((s) => s.reconnectCount);
  const serverError = useServerStore((s) => s.error);
  const channelError = useChannelStore((s) => s.error);
  const dmChannels = useDMStore((s) => s.dmChannels);
  const dmLoading = useDMStore((s) => s.isLoading);
  const dmError = useDMStore((s) => s.error);
  const pendingRequestCount = useDMStore((s) => s.messageRequests.length);
  const friendRequestCount = useFriendStore((s) => s.incomingRequests.length);
  const dmUnreadCount = useReadStateStore((s) =>
    dmChannels.reduce(
      (sum, dm) => sum + (s.byChannel[dm.channel?.id ?? '']?.unreadCount ?? 0),
      0,
    ),
  );
  const totalDMNotifications =
    dmUnreadCount + pendingRequestCount + friendRequestCount;
  const sidebarFocusedPaneId = useTilingStore((s) => s.focusedPaneId);
  const sidebarSetPaneContent = useTilingStore((s) => s.setPaneContent);

  const pendingInvite = useInviteStore((s) => s.pendingCode);

  // Poll voice channel participants for the selected server
  useVoiceChannelParticipants(selectedServerId, isAuthenticated);

  const [createOpen, setCreateOpen] = useState(false);
  const [joinOpen, setJoinOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);

  // Auto-open JoinServerDialog when a pending invite code exists
  useEffect(() => {
    if (pendingInvite) {
      setJoinOpen(true);
    }
  }, [pendingInvite]);

  // Fetch servers on mount (and on reconnect)
  // biome-ignore lint/correctness/useExhaustiveDependencies: reconnectCount is an intentional trigger to re-fetch after gateway reconnect
  useEffect(() => {
    if (!isAuthenticated) return;
    listServers().catch(() => {});
  }, [isAuthenticated, reconnectCount]);

  // Auto-select first server if none selected (and not in DM mode)
  const serverList = useMemo(() => Object.values(servers), [servers]);

  // Navigate focused pane to the first text channel of a server
  const pendingServerNavRef = useRef<string | null>(null);
  const navigateToDefaultChannel = useCallback((serverId: string) => {
    // If onboarding/rules not yet completed, show onboarding instead of channel.
    // Only redirect when member data is loaded — if `me` is undefined we fall
    // through to normal channel navigation (the sidebar's rulesBlocked guard
    // will catch it reactively once members load).
    const srv = useServerStore.getState().servers[serverId];
    if (srv?.onboardingEnabled || srv?.rulesRequired) {
      const userId = useAuthStore.getState().user?.id;
      const members = useMemberStore.getState().byServer[serverId] ?? [];
      const me = members.find((m) => m.userId === userId);
      if (me) {
        const needsOnboarding =
          (srv.onboardingEnabled && !me.onboardingCompletedAt) ||
          (srv.rulesRequired && !me.rulesAcknowledgedAt);
        if (needsOnboarding) {
          const { focusedPaneId, setPaneContent } = useTilingStore.getState();
          setPaneContent(focusedPaneId, {
            type: 'serverOnboarding',
            serverId,
          });
          pendingServerNavRef.current = null;
          return;
        }
      }
    }

    const serverChannels = useChannelStore.getState().byServer[serverId];
    if (serverChannels?.length) {
      const first =
        serverChannels.find((ch) => ch.type !== ChannelType.VOICE) ??
        serverChannels[0];
      if (first) {
        const { focusedPaneId, setPaneContent } = useTilingStore.getState();
        setPaneContent(focusedPaneId, {
          type: 'channel',
          channelId: first.id,
        });
        pendingServerNavRef.current = null;
        return;
      }
    }
    // Channels not loaded yet — mark pending so the effect handles it
    pendingServerNavRef.current = serverId;
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: isMobile is stable and intentionally excluded to avoid re-triggering
  useEffect(() => {
    const first = serverList[0];
    if (!selectedServerId && !showDMs && first) {
      selectServer(first.id);
      if (!isMobile) navigateToDefaultChannel(first.id);
    }
  }, [
    selectedServerId,
    showDMs,
    serverList,
    selectServer,
    navigateToDefaultChannel,
  ]);

  // Always fetch DM channels and message requests so the unread badge on
  // the DM icon works even when the user is viewing a server.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reconnectCount is an intentional trigger to re-fetch after gateway reconnect
  useEffect(() => {
    if (!isAuthenticated) return;
    listDMChannels().catch(() => {});
    listMessageRequests().catch(() => {});
    listFriendRequests().catch(() => {});
  }, [isAuthenticated, reconnectCount]);

  // Fetch friends list when entering DM mode (and on reconnect)
  // biome-ignore lint/correctness/useExhaustiveDependencies: reconnectCount is an intentional trigger to re-fetch after gateway reconnect
  useEffect(() => {
    if (!isAuthenticated || !showDMs) return;
    listFriends().catch(() => {});
  }, [showDMs, isAuthenticated, reconnectCount]);

  // Fetch channels and channel groups when selected server changes (and on reconnect)
  // biome-ignore lint/correctness/useExhaustiveDependencies: reconnectCount is an intentional trigger to re-fetch after gateway reconnect
  useEffect(() => {
    if (!isAuthenticated) return;
    if (selectedServerId) {
      // Skip for federated servers — data comes from spoke gateway events
      if (isFederatedServer) return;
      listChannels(selectedServerId).catch(() => {});
      listChannelGroups(selectedServerId).catch(() => {});
    }
  }, [selectedServerId, isAuthenticated, reconnectCount]);

  // Fetch presence for server members (and on reconnect)
  const presenceIntervalRef = useRef<ReturnType<typeof setInterval> | null>(
    null,
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: reconnectCount is an intentional trigger to re-fetch after gateway reconnect
  useEffect(() => {
    if (!isAuthenticated || !selectedServerId) return;
    // Skip for federated servers — data comes from spoke gateway events
    if (useFederationStore.getState().serverIndex[selectedServerId]) return;

    const fetchPresence = () => {
      listMembers(selectedServerId, { limit: 200 })
        .then((members) => {
          const userIds = members.map((m) => m.userId);
          if (userIds.length > 0) getBulkPresence(userIds).catch(() => {});
        })
        .catch(() => {});
    };

    fetchPresence();
    presenceIntervalRef.current = setInterval(fetchPresence, 60_000);
    return () => {
      if (presenceIntervalRef.current)
        clearInterval(presenceIntervalRef.current);
    };
  }, [selectedServerId, isAuthenticated, reconnectCount]);

  const channels = useChannelStore((s) =>
    selectedServerId
      ? (s.byServer[selectedServerId] ?? EMPTY_CHANNELS)
      : EMPTY_CHANNELS,
  );

  // Fulfill pending server navigation once channels load
  // biome-ignore lint/correctness/useExhaustiveDependencies: pendingServerNavRef is a stable ref
  useEffect(() => {
    if (
      pendingServerNavRef.current &&
      pendingServerNavRef.current === selectedServerId &&
      channels.length > 0
    ) {
      navigateToDefaultChannel(pendingServerNavRef.current);
    }
  }, [selectedServerId, channels]);

  const channelGroups = useChannelGroupStore((s) =>
    selectedServerId
      ? (s.byServer[selectedServerId] ?? EMPTY_GROUPS)
      : EMPTY_GROUPS,
  );

  // Single-pass channel grouping + text/voice split for stable references
  const { ungroupedText, ungroupedVoice, groupedChannels } = useMemo(() => {
    // Build set of companion text channel IDs to exclude from the sidebar.
    // Companions are discovered via the voice channel's voiceTextChannelId field.
    const companionIds = new Set<string>();
    for (const ch of channels) {
      if (ch.voiceTextChannelId) {
        companionIds.add(ch.voiceTextChannelId);
      }
    }

    const grouped = new Map<string, typeof channels>();
    const text: typeof channels = [];
    const voice: typeof channels = [];
    for (const ch of channels) {
      if (companionIds.has(ch.id)) continue; // Hide companion text channels
      if (ch.channelGroupId) {
        let list = grouped.get(ch.channelGroupId);
        if (!list) {
          list = [];
          grouped.set(ch.channelGroupId, list);
        }
        list.push(ch);
      } else if (ch.type === ChannelType.VOICE) {
        voice.push(ch);
      } else {
        text.push(ch);
      }
    }
    return {
      ungroupedText: text,
      ungroupedVoice: voice,
      groupedChannels: grouped,
    };
  }, [channels]);

  const [createChannelOpen, setCreateChannelOpen] = useState(false);
  const [createChannelGroupId, setCreateChannelGroupId] = useState<
    string | undefined
  >();
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [createGroupDMOpen, setCreateGroupDMOpen] = useState(false);

  const focusedPaneId = sidebarFocusedPaneId;
  const setPaneContent = sidebarSetPaneContent;

  const [serverNotifyLevel, setServerNotifyLevel] = useState<string | null>(
    null,
  );

  // Reset and reload notification preference when server changes
  useEffect(() => {
    setServerNotifyLevel(null);
    if (!selectedServerId) return;
    // Skip for federated servers — notification prefs are origin-only
    if (isFederatedServer) return;
    let cancelled = false;
    (async () => {
      try {
        const prefs = await getNotificationPreferences();
        if (cancelled) return;
        const serverPref = prefs.find(
          (p) => p.scopeType === 'server' && p.scopeId === selectedServerId,
        );
        setServerNotifyLevel(serverPref?.level ?? 'all');
      } catch {
        if (!cancelled) setServerNotifyLevel('all');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedServerId, isFederatedServer]);

  const handleSetNotifyLevel = useCallback(
    async (level: string) => {
      if (!selectedServerId) return;
      const prev = serverNotifyLevel;
      setServerNotifyLevel(level);
      try {
        await updateNotificationPreference('server', selectedServerId, level);
      } catch {
        setServerNotifyLevel(prev);
      }
    },
    [selectedServerId, serverNotifyLevel],
  );

  // Check if current user is blocked by rules requirement
  const currentUserId = useAuthStore((s) => s.user?.id);
  const selectedServer = selectedServerId
    ? servers[selectedServerId]
    : undefined;
  const currentMember = useMemberStore((s) => {
    if (!selectedServerId || !currentUserId) return undefined;
    return s.byServer[selectedServerId]?.find(
      (m) => m.userId === currentUserId,
    );
  });
  // Show sync divergence indicators for users who can manage permissions.
  // Server owners always see them; for others, check ManageRoles permission.
  const serverRoles = useRoleStore((s) =>
    selectedServerId ? s.byServer[selectedServerId] : undefined,
  );
  const showSyncIndicators = useMemo(() => {
    if (!selectedServerId || !currentUserId) return false;
    if (selectedServer?.ownerId === currentUserId) return true;
    const member = currentMember;
    if (!member) return false;
    const roles = serverRoles ?? [];
    for (const role of roles) {
      if (
        member.roleIds.includes(role.id) &&
        (role.permissions & Permissions.MANAGE_ROLES) !== 0n
      ) {
        return true;
      }
    }
    return false;
  }, [
    selectedServerId,
    currentUserId,
    selectedServer?.ownerId,
    currentMember,
    serverRoles,
  ]);

  // Block until we have member data confirming rules were acknowledged.
  // When currentMember is undefined (not loaded yet), stay blocked to
  // prevent a flash of channel content before the member record arrives.
  const rulesBlocked =
    !!selectedServer?.rulesRequired &&
    (!currentMember || !currentMember.rulesAcknowledgedAt);

  return (
    <aside
      className="flex h-full flex-shrink-0 flex-col bg-bg-overlay"
      style={style}
    >
      {/* Two-column layout: server icons | channel list */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Server list */}
        <nav
          className="flex w-20 md:w-16 flex-shrink-0 flex-col items-center gap-2.5 md:gap-2 overflow-y-auto border-r border-border/40 px-1.5 md:px-1 py-3"
          aria-label="Servers"
        >
          {/* DM icon */}
          <div className="relative flex items-center">
            {showDMs && (
              <span className="absolute left-[-0.625rem] h-5 w-1 rounded-r-full bg-text" />
            )}
            <button
              type="button"
              className={`relative flex h-12 w-12 md:h-10 md:w-10 items-center justify-center rounded-[10px] text-xl font-semibold transition-colors ${
                showDMs
                  ? 'bg-bg-surface text-accent'
                  : 'bg-bg-surface text-text-muted hover:bg-bg-elevated'
              }`}
              title="Direct Messages"
              onClick={() => {
                selectDMs();
                if (!isMobile) {
                  const {
                    focusedPaneId: fpId,
                    panes,
                    setPaneContent: setPC,
                  } = useTilingStore.getState();
                  const current = panes[fpId];
                  const isDMRelated =
                    current?.type === 'dm' ||
                    current?.type === 'dmsHome' ||
                    current?.type === 'friends' ||
                    current?.type === 'messageRequests';
                  if (!isDMRelated) {
                    setPC(fpId, { type: 'dmsHome' });
                  }
                }
              }}
            >
              <MezaIcon className="h-7 w-7 md:h-6 md:w-6" />
              {totalDMNotifications > 0 && !showDMs && (
                <span className="absolute -bottom-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full bg-accent text-[10px] font-bold leading-none text-black ring-2 ring-bg-overlay">
                  {totalDMNotifications > 9 ? '9+' : totalDMNotifications}
                </span>
              )}
            </button>
          </div>

          <div className="h-2" />

          {serversLoading ? (
            <div className="text-sm text-text-subtle">Loading…</div>
          ) : null}
          {serverError && (
            <div className="text-sm text-error">
              {serverError}{' '}
              <button
                type="button"
                className="underline"
                onClick={() => {
                  useServerStore.getState().setError(null);
                  listServers().catch(() => {});
                }}
              >
                Retry
              </button>
            </div>
          )}
          {serverList.map((server) => (
            <ServerIcon
              key={server.id}
              serverId={server.id}
              serverName={server.name}
              iconUrl={server.iconUrl}
              isSelected={server.id === selectedServerId}
              onSelect={() => {
                selectServer(server.id);
                if (!isMobile) navigateToDefaultChannel(server.id);
              }}
            />
          ))}

          {/* Create & Join server buttons */}
          <div className="flex flex-col gap-2">
            <button
              type="button"
              onClick={() => {
                const { focusedPaneId, setPaneContent } =
                  useTilingStore.getState();
                setPaneContent(focusedPaneId, { type: 'createServer' });
              }}
              className="flex h-12 w-12 md:h-10 md:w-10 items-center justify-center rounded-[10px] border-2 border-dashed border-border text-text-muted hover:border-accent hover:text-accent transition-colors"
              aria-label="Create server"
              title="Create a server"
            >
              <PlusIcon size={16} weight="regular" aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() => setJoinOpen(true)}
              className="flex h-12 w-12 md:h-10 md:w-10 items-center justify-center rounded-[10px] border-2 border-dashed border-border text-text-muted hover:border-accent hover:text-accent transition-colors"
              aria-label="Join server"
              title="Join a server"
            >
              <ArrowRightIcon size={16} weight="regular" aria-hidden="true" />
            </button>
          </div>
        </nav>

        {/* Channel / DM list */}
        <nav
          className="flex flex-1 min-w-0 flex-col gap-1 md:gap-0.5 overflow-y-auto pl-2 pr-2 md:pl-1.5 md:pr-1.5 py-3"
          data-sidebar-scroll
          aria-label={showDMs ? 'Direct Messages' : 'Channels'}
        >
          {showDMs ? (
            <>
              <div className="mb-2 flex items-center justify-between">
                <button
                  type="button"
                  className="truncate text-sm font-semibold uppercase tracking-wider text-text-subtle hover:text-text transition-colors"
                  onClick={() => {
                    if (sidebarFocusedPaneId) {
                      sidebarSetPaneContent(sidebarFocusedPaneId, {
                        type: 'dmsHome',
                      });
                    }
                  }}
                >
                  Direct Messages
                </button>
                <button
                  type="button"
                  className="flex h-5 w-5 items-center justify-center rounded text-text-subtle hover:text-text hover:bg-bg-tertiary transition-colors"
                  title="Create Group DM"
                  onClick={() => setCreateGroupDMOpen(true)}
                >
                  <PlusIcon size={16} weight="regular" aria-hidden="true" />
                </button>
              </div>

              <button
                type="button"
                className="flex items-center justify-between w-full px-2 py-2.5 md:py-1.5 mb-1 text-base font-medium text-text-primary rounded hover:bg-bg-tertiary transition-colors"
                onClick={() => {
                  if (sidebarFocusedPaneId) {
                    sidebarSetPaneContent(sidebarFocusedPaneId, {
                      type: 'friends',
                    });
                  }
                }}
              >
                <span>Friends</span>
                {friendRequestCount > 0 && (
                  <span className="flex items-center justify-center min-w-5 h-5 px-1 text-sm font-bold text-white bg-accent rounded-full">
                    {friendRequestCount}
                  </span>
                )}
              </button>

              {pendingRequestCount > 0 && (
                <button
                  type="button"
                  className="flex items-center justify-between w-full px-2 py-2.5 md:py-1.5 mb-1 text-base font-medium text-text-primary rounded hover:bg-bg-tertiary transition-colors"
                  onClick={() => {
                    if (sidebarFocusedPaneId) {
                      sidebarSetPaneContent(sidebarFocusedPaneId, {
                        type: 'messageRequests',
                      });
                    }
                  }}
                >
                  <span>Requests</span>
                  <span className="flex items-center justify-center min-w-5 h-5 px-1 text-sm font-bold text-white bg-red-500 rounded-full">
                    {pendingRequestCount}
                  </span>
                </button>
              )}

              {dmLoading ? (
                <div className="px-2 py-1 text-sm text-text-subtle">
                  Loading…
                </div>
              ) : dmChannels.length === 0 ? (
                <div className="px-2 py-1 text-sm text-text-subtle">
                  No conversations yet
                </div>
              ) : null}
              {dmError && (
                <div className="px-2 py-1 text-sm text-error">
                  {dmError}{' '}
                  <button
                    type="button"
                    className="underline"
                    onClick={() => {
                      useDMStore.getState().setError(null);
                      listDMChannels().catch(() => {});
                    }}
                  >
                    Retry
                  </button>
                </div>
              )}

              {dmChannels.map((dm) => (
                <SidebarDMItem key={dm.channel?.id} dm={dm} />
              ))}
            </>
          ) : (
            <>
              {/* Server banner + header with hover tray */}
              {selectedServerId &&
                servers[selectedServerId] &&
                (() => {
                  const srv = servers[selectedServerId];
                  const bannerSrc = srv.bannerUrl
                    ? resolveIconUrl(srv.bannerUrl)
                    : undefined;
                  const onBanner = !!bannerSrc;
                  const colorClass = onBanner
                    ? 'text-white/60 hover:text-white hover:bg-white/10'
                    : 'text-text-muted hover:text-text hover:bg-bg-surface-hover';
                  const btnClass = `rounded-md ${colorClass} transition-all duration-150 ${isMobile ? 'p-1.5' : 'p-0.5 scale-90 group-hover/header:scale-100 group-hover/header:p-1'}`;
                  const iconSize = isMobile ? 20 : 16;

                  const actionButtons = (
                    <div
                      className={`flex items-center ${isMobile ? 'gap-2' : 'gap-0.5'}`}
                    >
                      <button
                        type="button"
                        onClick={() => setInviteOpen(true)}
                        className={btnClass}
                        aria-label="Invite people"
                        title="Invite people"
                      >
                        <UserPlusIcon size={iconSize} aria-hidden="true" />
                      </button>
                      {!isMobile && (
                        <Popover.Root>
                          <Popover.Trigger asChild>
                            <button
                              type="button"
                              className={btnClass}
                              aria-label="Notification preferences"
                              title="Notification preferences"
                            >
                              {serverNotifyLevel === 'nothing' ? (
                                <BellSimpleSlashIcon
                                  size={iconSize}
                                  aria-hidden="true"
                                />
                              ) : (
                                <BellSimpleIcon
                                  size={iconSize}
                                  aria-hidden="true"
                                />
                              )}
                            </button>
                          </Popover.Trigger>
                          <Popover.Portal>
                            <Popover.Content
                              className="w-[200px] rounded-lg bg-bg-elevated p-1 shadow-lg animate-scale-in z-50"
                              sideOffset={6}
                              align="end"
                            >
                              <p className="px-2 py-1.5 text-xs font-semibold uppercase tracking-wider text-text-subtle">
                                Notify for…
                              </p>
                              {(
                                [
                                  ['all', 'All messages'],
                                  ['mentions_only', 'Mentions only'],
                                  ['nothing', 'Nothing'],
                                ] as const
                              ).map(([value, label]) => (
                                <Popover.Close asChild key={value}>
                                  <button
                                    type="button"
                                    onClick={() => handleSetNotifyLevel(value)}
                                    className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors ${
                                      serverNotifyLevel === value
                                        ? 'text-accent bg-accent-subtle'
                                        : 'text-text hover:bg-bg-surface-hover'
                                    }`}
                                  >
                                    {label}
                                  </button>
                                </Popover.Close>
                              ))}
                            </Popover.Content>
                          </Popover.Portal>
                        </Popover.Root>
                      )}
                      <button
                        type="button"
                        onClick={() =>
                          setPaneContent(focusedPaneId, {
                            type: 'serverSettings',
                            serverId: selectedServerId,
                          })
                        }
                        className={btnClass}
                        aria-label="Server settings"
                        title="Server settings"
                      >
                        <GearIcon size={iconSize} aria-hidden="true" />
                      </button>
                    </div>
                  );

                  return (
                    <div className="group/header">
                      {bannerSrc ? (
                        <div className="relative w-full h-[120px] overflow-hidden rounded-t-md -mt-1">
                          <img
                            src={bannerSrc}
                            alt=""
                            className="h-full w-full object-cover"
                          />
                          <div className="absolute inset-x-0 top-0 bg-gradient-to-b from-black/90 via-black/60 to-transparent">
                            <div className="flex items-center gap-1 px-2 py-2">
                              <h2 className="min-w-0 flex-1 text-sm font-semibold text-white truncate drop-shadow-sm">
                                {srv.name}
                              </h2>
                              {actionButtons}
                            </div>
                          </div>
                        </div>
                      ) : (
                        <div className="flex items-center gap-1 px-2 py-2">
                          <h2 className="min-w-0 flex-1 text-base font-semibold text-text truncate">
                            {srv.name}
                          </h2>
                          {actionButtons}
                        </div>
                      )}
                    </div>
                  );
                })()}

              {rulesBlocked ? (
                <div className="flex flex-1 flex-col items-center justify-center px-4 py-8 text-center">
                  <div className="mb-3">
                    <ScrollIcon
                      size={24}
                      className="text-text-subtle"
                      aria-hidden="true"
                    />
                  </div>
                  <p className="mb-1 text-sm font-medium text-text">
                    Rules acknowledgement required
                  </p>
                  <p className="mb-4 text-xs text-text-muted">
                    You need to read and accept the server rules before you can
                    access channels.
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      if (!selectedServerId) return;
                      setPaneContent(focusedPaneId, {
                        type: 'serverOnboarding',
                        serverId: selectedServerId,
                      });
                    }}
                    className="rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-black hover:bg-accent-hover"
                  >
                    Read the rules
                  </button>
                </div>
              ) : (
                <>
                  {channelsLoading ? (
                    <div className="px-2 py-1 text-sm text-text-subtle">
                      Loading…
                    </div>
                  ) : channels.length === 0 && selectedServerId ? (
                    <div className="px-2 py-1 text-sm text-text-subtle">
                      No channels
                    </div>
                  ) : null}
                  {channelError && (
                    <div className="px-2 py-1 text-sm text-error">
                      {channelError}{' '}
                      <button
                        type="button"
                        className="underline"
                        onClick={() => {
                          useChannelStore.getState().setError(null);
                          if (selectedServerId)
                            listChannels(selectedServerId).catch(() => {});
                        }}
                      >
                        Retry
                      </button>
                    </div>
                  )}

                  {/* Text channels */}
                  <div className="mb-2 flex items-center justify-between pl-2">
                    <h2 className="text-sm font-semibold text-text-subtle">
                      Text
                    </h2>
                    {selectedServerId && (
                      <button
                        type="button"
                        className="flex h-7 w-7 items-center justify-center rounded text-xl text-text-subtle transition-colors hover:bg-bg-surface hover:text-text"
                        aria-label="Create text channel"
                        onClick={() => setCreateChannelOpen(true)}
                      >
                        +
                      </button>
                    )}
                  </div>
                  {ungroupedText.map((channel) => (
                    <SidebarChannelItem
                      key={channel.id}
                      channelId={channel.id}
                      channelName={channel.name}
                      channelType={channel.type}
                      isPrivate={channel.isPrivate}
                      serverId={selectedServerId ?? undefined}
                    />
                  ))}

                  {/* Voice channels */}
                  {ungroupedVoice.length > 0 && (
                    <>
                      <div className="mt-4 mb-2 flex items-center justify-between pl-2">
                        <h2 className="text-sm font-semibold text-text-subtle">
                          Voice
                        </h2>
                        {selectedServerId && (
                          <button
                            type="button"
                            className="flex h-7 w-7 items-center justify-center rounded text-xl text-text-subtle transition-colors hover:bg-bg-surface hover:text-text"
                            aria-label="Create voice channel"
                            onClick={() => setCreateChannelOpen(true)}
                          >
                            +
                          </button>
                        )}
                      </div>
                      {ungroupedVoice.map((channel) => (
                        <SidebarChannelItem
                          key={channel.id}
                          channelId={channel.id}
                          channelName={channel.name}
                          channelType={channel.type}
                          isPrivate={channel.isPrivate}
                          serverId={selectedServerId ?? undefined}
                          voiceTextChannelId={channel.voiceTextChannelId}
                        />
                      ))}
                    </>
                  )}

                  {/* Grouped channels */}
                  {channelGroups.map((group) => (
                    <SidebarChannelGroup
                      key={group.id}
                      groupId={group.id}
                      groupName={group.name}
                      channels={groupedChannels.get(group.id) ?? []}
                      serverId={selectedServerId ?? undefined}
                      onCreateChannel={() => {
                        setCreateChannelGroupId(group.id);
                        setCreateChannelOpen(true);
                      }}
                      onEditPermissions={
                        showSyncIndicators && selectedServerId
                          ? () =>
                              openCategoryPermissionsPane(
                                selectedServerId,
                                group.id,
                              )
                          : undefined
                      }
                      showSyncIndicators={showSyncIndicators}
                    />
                  ))}

                  {/* Create category — pinned to bottom */}
                  {selectedServerId && (
                    <div className="mt-auto pt-4 px-2">
                      {creatingGroup ? (
                        <CreateGroupInlineForm
                          serverId={selectedServerId}
                          onDone={() => setCreatingGroup(false)}
                        />
                      ) : (
                        <button
                          type="button"
                          onClick={() => setCreatingGroup(true)}
                          className="flex w-full items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-sm text-text-subtle transition-colors hover:bg-bg-surface hover:text-text"
                          aria-label="Create category"
                        >
                          <span className="text-base">+</span>
                          <span>New Category</span>
                        </button>
                      )}
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </nav>
      </div>

      {/* Voice connection bar (visible when connected) */}
      {isMobile ? <MobileVoiceBar /> : <VoiceConnectionBar />}

      {/* Settings footer */}
      <SidebarFooter />

      {/* Dialogs */}
      <CreateServerDialog open={createOpen} onOpenChange={setCreateOpen} />
      <JoinServerDialog
        open={joinOpen}
        onOpenChange={setJoinOpen}
        initialCode={pendingInvite ?? undefined}
      />
      {selectedServerId && (
        <InviteDialog
          open={inviteOpen}
          onOpenChange={setInviteOpen}
          serverId={selectedServerId}
        />
      )}
      {selectedServerId && createChannelOpen && (
        <CreateChannelDialog
          serverId={selectedServerId}
          open={createChannelOpen}
          onOpenChange={(open) => {
            setCreateChannelOpen(open);
            if (!open) setCreateChannelGroupId(undefined);
          }}
          channelGroupId={createChannelGroupId}
        />
      )}
      <CreateGroupDMDialog
        open={createGroupDMOpen}
        onOpenChange={setCreateGroupDMOpen}
      />
    </aside>
  );
}

function SidebarFooter() {
  const user = useAuthStore((s) => s.user);
  const setOverlay = useTilingStore((s) => s.setOverlay);
  const voiceStatus = useVoiceStore((s) => s.status);
  const localSpeaking = useLocalSpeaking();
  const isSpeaking = voiceStatus === 'connected' && localSpeaking;
  const room = useMaybeRoomContext();
  const isVoiceConnected = voiceStatus === 'connected' && !!room;
  const [micEnabled, setMicEnabled] = useState(true);

  useEffect(() => {
    if (!room) {
      setMicEnabled(true);
      return;
    }
    const lp = room.localParticipant;
    const update = () => setMicEnabled(lp.isMicrophoneEnabled);
    update();
    lp.on(ParticipantEvent.TrackMuted, update);
    lp.on(ParticipantEvent.TrackUnmuted, update);
    lp.on(ParticipantEvent.LocalTrackPublished, update);
    return () => {
      lp.off(ParticipantEvent.TrackMuted, update);
      lp.off(ParticipantEvent.TrackUnmuted, update);
      lp.off(ParticipantEvent.LocalTrackPublished, update);
    };
  }, [room]);

  return (
    <div className="flex-shrink-0 mx-1.5 mb-4 mt-1 h-[60px] rounded-lg border border-border/50 bg-bg-surface px-3">
      <div className="flex h-full items-center gap-2">
        <button
          type="button"
          className="flex flex-1 min-w-0 items-center gap-2 rounded-md hover:bg-bg-elevated transition-colors -my-1 -ml-2 -mr-1 py-1 pl-2 pr-1"
          onClick={() => user?.id && openProfilePane(user.id)}
          aria-label="View profile"
        >
          <div className="relative">
            <div
              className={`rounded-full transition-shadow ${
                isSpeaking
                  ? 'ring-[2.5px] ring-success shadow-[0_0_6px_rgba(0,196,118,0.4)]'
                  : ''
              }`}
            >
              <Avatar
                avatarUrl={user?.avatarUrl}
                displayName={user?.displayName || 'Unknown'}
                size="lg"
                className="!bg-bg-elevated"
              />
            </div>
            {user?.id && (
              <PresenceDot
                userId={user.id}
                size="md"
                className="absolute bottom-0 right-0 ring-2 ring-bg-overlay"
              />
            )}
          </div>
          <div className="flex-1 min-w-0 text-left">
            <div className="text-base font-medium text-text truncate">
              {user?.displayName || 'Unknown'}
            </div>
          </div>
        </button>
        <div className="flex-shrink-0">
          <StatusPicker />
        </div>
        <button
          type="button"
          className={`p-1 transition-colors ${
            !isVoiceConnected
              ? 'text-text-subtle cursor-not-allowed'
              : micEnabled
                ? 'text-text-muted hover:text-text'
                : 'text-error hover:text-error/80'
          }`}
          disabled={!isVoiceConnected}
          onClick={() => {
            if (!room) return;
            room.localParticipant.setMicrophoneEnabled(!micEnabled);
            const { soundEnabled, enabledSounds } =
              useNotificationSettingsStore.getState();
            const type = micEnabled ? 'mute' : 'unmute';
            if (soundEnabled && enabledSounds[type]) soundManager.play(type);
          }}
          aria-label={micEnabled ? 'Mute' : 'Unmute'}
          title={
            isVoiceConnected ? (micEnabled ? 'Mute' : 'Unmute') : 'Not in voice'
          }
        >
          {micEnabled ? (
            <MicrophoneIcon size={22} aria-hidden="true" />
          ) : (
            <MicrophoneSlashIcon size={22} aria-hidden="true" />
          )}
        </button>
        <button
          type="button"
          className="p-1 text-text-muted hover:text-text"
          onClick={() => setOverlay({ type: 'settings' })}
          aria-label="Settings"
        >
          <GearIcon size={22} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

function SidebarDMItem({ dm }: { dm: DMChannel }) {
  const currentUserId = useAuthStore((s) => s.user?.id) ?? '';
  const focusedPaneId = useTilingStore((s) => s.focusedPaneId);
  const setPaneContent = useTilingStore((s) => s.setPaneContent);
  const focusedContent = useTilingStore((s) => s.panes[s.focusedPaneId]);

  const channelId = dm.channel?.id ?? '';
  const unreadCount = useReadStateStore(
    (s) => s.byChannel[channelId]?.unreadCount ?? 0,
  );
  const hasUnread = unreadCount > 0;
  const isGroup = isGroupDM(dm);
  const selfDM = isSelfDM(dm, currentUserId);
  const displayName = getDMDisplayName(dm, currentUserId);
  const self = selfDM ? dm.participants[0] : undefined;
  const other =
    !isGroup && !selfDM
      ? (dm.participants.find((p: { id: string }) => p.id !== currentUserId) as
          | {
              id: string;
              displayName: string;
              username: string;
              avatarUrl?: string;
            }
          | undefined)
      : undefined;
  const active =
    focusedContent?.type === 'dm' &&
    focusedContent.conversationId === channelId;

  const dmContent: PaneContent = { type: 'dm', conversationId: channelId };
  const {
    attributes: dragAttributes,
    listeners: dragListeners,
    setNodeRef: setDragRef,
    isDragging,
  } = useDraggable({
    id: `sidebar-dm-${channelId}`,
    data: { type: 'sidebar' as const, content: dmContent, label: displayName },
  });

  return (
    <button
      ref={setDragRef}
      {...dragAttributes}
      {...dragListeners}
      type="button"
      className={`flex items-center gap-2 rounded-md px-2 py-2.5 md:py-1.5 text-base transition-colors ${
        isDragging ? 'opacity-40' : ''
      } ${
        active
          ? 'bg-bg-surface text-text'
          : hasUnread
            ? 'text-text hover:bg-bg-surface'
            : 'text-text-muted hover:bg-bg-surface hover:text-text'
      }`}
      onClick={() =>
        setPaneContent(focusedPaneId, { type: 'dm', conversationId: channelId })
      }
    >
      <div className="relative">
        {selfDM && self ? (
          <Avatar
            avatarUrl={self.avatarUrl}
            displayName={self.displayName || self.username || 'You'}
            size="sm"
          />
        ) : isGroup ? (
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-bg-tertiary text-text-subtle">
            <UsersThreeIcon size={16} aria-hidden="true" />
          </div>
        ) : (
          <>
            <Avatar
              avatarUrl={other?.avatarUrl}
              displayName={displayName}
              size="sm"
            />
            {other?.id && (
              <PresenceDot
                userId={other.id}
                size="sm"
                className="absolute -bottom-0.5 -right-0.5 ring-2 ring-bg-overlay"
              />
            )}
          </>
        )}
      </div>
      <span
        className={`flex-1 truncate text-left ${hasUnread ? 'font-semibold' : ''}`}
      >
        {displayName}
      </span>
      {isGroup && (
        <span className="text-xs text-text-subtle">
          {dm.participants.length}
        </span>
      )}
      {hasUnread && (
        <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-xs font-bold text-black">
          {unreadCount >= 1000 ? '999+' : unreadCount}
        </span>
      )}
    </button>
  );
}

function CreateGroupInlineForm({
  serverId,
  onDone,
}: {
  serverId: string;
  onDone: () => void;
}) {
  const [name, setName] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <form
      className="mt-2 px-1"
      onSubmit={async (e) => {
        e.preventDefault();
        const trimmed = name.trim();
        if (!trimmed) return;
        try {
          await createChannelGroup(serverId, trimmed);
          onDone();
        } catch {
          // Error handled by store
        }
      }}
    >
      <input
        ref={inputRef}
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onDone();
        }}
        onBlur={onDone}
        placeholder="New category name"
        maxLength={100}
        className="w-full rounded-md border border-border bg-bg-surface px-2 py-1 text-sm text-text placeholder:text-text-muted focus:border-accent focus:outline-none"
      />
    </form>
  );
}

function ServerIcon({
  serverId,
  serverName,
  iconUrl,
  isSelected,
  onSelect,
}: {
  serverId: string;
  serverName: string;
  iconUrl?: string;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const hasUnread = useReadStateStore((s) => {
    const channels = useChannelStore.getState().byServer[serverId];
    if (!channels) return false;
    return channels.some((ch) => (s.byChannel[ch.id]?.unreadCount ?? 0) > 0);
  });

  // Show the static thumbnail by default; swap to the full (possibly animated) URL on hover.
  // resolveMediaUrl handles both origin and federated server URLs/tokens.
  const iconSrc = iconUrl
    ? resolveMediaUrl(serverId, iconUrl, { thumb: !hovered })
    : undefined;

  return (
    <div className="relative flex items-center">
      {isSelected && (
        <span className="absolute left-[-0.625rem] h-5 w-1 rounded-r-full bg-text" />
      )}
      <button
        type="button"
        className={`relative flex h-12 w-12 md:h-10 md:w-10 items-center justify-center overflow-hidden rounded-[10px] text-sm font-semibold transition-colors ${
          isSelected
            ? iconSrc
              ? ''
              : 'bg-accent text-black'
            : 'bg-bg-surface text-text-muted hover:bg-bg-elevated'
        }`}
        title={serverName}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onClick={onSelect}
      >
        {iconSrc ? (
          <img
            src={iconSrc}
            alt={serverName}
            className="h-full w-full object-cover"
          />
        ) : (
          serverName.charAt(0).toUpperCase()
        )}
        {hasUnread && !isSelected && (
          <span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-accent ring-2 ring-bg-overlay" />
        )}
      </button>
    </div>
  );
}

function SidebarChannelGroup({
  groupId,
  groupName,
  channels,
  serverId,
  onCreateChannel,
  onEditPermissions,
  showSyncIndicators,
}: {
  groupId: string;
  groupName: string;
  channels: {
    id: string;
    name: string;
    type: ChannelType;
    isPrivate: boolean;
    voiceTextChannelId?: string;
  }[];
  serverId?: string;
  onCreateChannel?: () => void;
  onEditPermissions?: () => void;
  showSyncIndicators?: boolean;
}) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className="mt-4" data-group-id={groupId}>
      <div className="group flex items-center">
        <button
          type="button"
          onClick={() => setCollapsed(!collapsed)}
          className="flex flex-1 min-w-0 items-center gap-1 px-2 py-0.5 text-left"
        >
          <span className="text-xs text-text-subtle">
            {collapsed ? (
              <CaretRightIcon size={12} aria-hidden="true" />
            ) : (
              <CaretDownIcon size={12} aria-hidden="true" />
            )}
          </span>
          <span className="truncate text-xs font-semibold uppercase tracking-wide text-text-subtle">
            {groupName}
          </span>
        </button>
        {onEditPermissions && (
          <button
            type="button"
            onClick={onEditPermissions}
            className="flex h-7 w-7 items-center justify-center rounded text-text-subtle opacity-0 transition-all hover:bg-bg-surface hover:text-text group-hover:opacity-100"
            aria-label={`Edit permissions for ${groupName}`}
            title="Edit permissions"
          >
            <GearIcon size={14} aria-hidden="true" />
          </button>
        )}
        {onCreateChannel && (
          <button
            type="button"
            onClick={onCreateChannel}
            className="flex h-7 w-7 items-center justify-center rounded text-xl text-text-subtle transition-colors hover:bg-bg-surface hover:text-text"
            aria-label={`Create channel in ${groupName}`}
            title="Create channel"
          >
            <PlusIcon size={16} weight="regular" aria-hidden="true" />
          </button>
        )}
      </div>
      {!collapsed && (
        <div className="flex flex-col gap-0.5">
          {channels.map((channel) => (
            <SidebarChannelItem
              key={channel.id}
              channelId={channel.id}
              channelName={channel.name}
              channelType={channel.type}
              isPrivate={channel.isPrivate}
              serverId={serverId}
              channelGroupId={groupId}
              voiceTextChannelId={channel.voiceTextChannelId}
              showSyncIndicator={showSyncIndicators}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SidebarChannelItem({
  channelId,
  channelName,
  channelType,
  isPrivate,
  serverId,
  channelGroupId,
  voiceTextChannelId,
  showSyncIndicator,
}: {
  channelId: string;
  channelName: string;
  channelType: ChannelType;
  isPrivate: boolean;
  serverId?: string;
  channelGroupId?: string;
  voiceTextChannelId?: string;
  showSyncIndicator?: boolean;
}) {
  const focusedPaneId = useTilingStore((s) => s.focusedPaneId);
  const setPaneContent = useTilingStore((s) => s.setPaneContent);
  const focusedContent = useTilingStore((s) => s.panes[s.focusedPaneId]);
  // For voice channels, show unread count from the companion text channel.
  const unreadChannelId = voiceTextChannelId || channelId;
  const unreadCount = useReadStateStore(
    (s) => s.byChannel[unreadChannelId]?.unreadCount ?? 0,
  );

  const { connect: voiceConnect } = useVoiceConnection();
  const isVoice = channelType === ChannelType.VOICE;
  const content: PaneContent = isVoice
    ? { type: 'voice', channelId }
    : { type: 'channel', channelId };
  const isDefaultFallback = useChannelStore((s) => {
    if (focusedContent?.type !== 'empty' || !serverId) return false;
    const channels = s.byServer[serverId];
    const firstText = channels?.find((c) => c.type === ChannelType.TEXT);
    return firstText?.id === channelId;
  });
  const active =
    ((focusedContent?.type === 'channel' || focusedContent?.type === 'voice') &&
      focusedContent.channelId === channelId) ||
    isDefaultFallback;

  const channelDataType = isVoice ? 'voice' : isPrivate ? 'private' : 'text';
  const hasUnread = unreadCount > 0;

  // Check if this channel has diverged permissions from its category
  const permissionsSynced = useChannelStore((s) => {
    if (!serverId) return true;
    const ch = s.byServer[serverId]?.find((c) => c.id === channelId);
    return ch?.permissionsSynced ?? true;
  });
  const showDiverged =
    showSyncIndicator && !!channelGroupId && !permissionsSynced;

  const participants = useVoiceParticipantsStore((s) => s.byChannel[channelId]);
  const voiceParticipants = isVoice && participants ? participants : EMPTY_ARR;
  const currentVoiceChannelId = useVoiceStore((s) => s.channelId);
  const isInSameChannel = currentVoiceChannelId === channelId;
  const isMobile = useMobile();
  const currentUserId = useAuthStore((s) => s.user?.id);
  const showStreamPreview = !isMobile;

  const {
    attributes: dragAttributes,
    listeners: dragListeners,
    setNodeRef: setDragRef,
    isDragging,
  } = useDraggable({
    id: `sidebar-channel-${channelId}`,
    data: { type: 'sidebar' as const, content, label: channelName },
  });

  const baseIcon = isVoice ? (
    <SpeakerHighIcon
      size={18}
      className={voiceParticipants.length > 0 ? 'text-success' : undefined}
      aria-hidden="true"
    />
  ) : (
    <HashIcon weight="regular" size={18} aria-hidden="true" />
  );

  const icon = isPrivate ? (
    <span className="relative" role="img" aria-label="Private channel">
      {baseIcon}
      <span
        className={`absolute -bottom-1 -right-1.5 flex h-3.5 w-3.5 items-center justify-center rounded-full transition-colors group-hover:bg-bg-surface ${active ? 'bg-bg-surface' : 'bg-bg-overlay'}`}
      >
        <LockSimpleIcon
          size={10}
          weight="fill"
          className={active ? 'text-accent' : 'text-text-subtle'}
          aria-hidden="true"
        />
      </span>
    </span>
  ) : (
    baseIcon
  );

  return (
    <div>
      <SidebarContextMenu
        content={content}
        channelId={channelId}
        channelName={channelName}
        serverId={serverId}
        isPrivate={isPrivate}
      >
        {/* biome-ignore lint/a11y/useSemanticElements: div required to avoid nested <button> (inner gear icon is a real button) */}
        <div
          ref={setDragRef}
          {...dragAttributes}
          {...dragListeners}
          role="button"
          tabIndex={0}
          className={`group flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-2.5 md:py-1.5 text-base transition-colors ${
            isDragging ? 'opacity-40' : ''
          } ${
            active
              ? 'bg-bg-surface text-text'
              : hasUnread
                ? 'text-text hover:bg-bg-surface'
                : 'text-text-muted hover:bg-bg-surface hover:text-text'
          }`}
          onClick={() => {
            setPaneContent(focusedPaneId, content);
            if (isVoice && useVoiceStore.getState().channelId !== channelId)
              voiceConnect(channelId, channelName);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              setPaneContent(focusedPaneId, content);
              if (isVoice && useVoiceStore.getState().channelId !== channelId)
                voiceConnect(channelId, channelName);
            }
          }}
          data-channel-type={channelDataType}
        >
          <span className={active ? 'text-accent' : 'text-text-subtle'}>
            {icon}
          </span>
          <span
            className={`flex-1 text-left ${hasUnread ? 'font-semibold' : ''} ${isVoice && voiceParticipants.length > 0 ? 'text-text' : ''}`}
          >
            {channelName}
          </span>
          {showDiverged && (
            <span
              className="shrink-0 text-text-subtle"
              title="Permissions diverged from category"
            >
              <LinkBreakIcon size={12} weight="bold" aria-hidden="true" />
            </span>
          )}
          {hasUnread && (
            <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-xs font-bold text-black">
              {unreadCount >= 1000 ? '999+' : unreadCount}
            </span>
          )}
          <button
            type="button"
            tabIndex={-1}
            className={`rounded p-0.5 text-text transition-opacity ${active ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'} hover:bg-bg-elevated`}
            onClick={(e) => {
              e.stopPropagation();
              if (serverId) openChannelSettingsPane(serverId, channelId);
            }}
            aria-label="Channel settings"
            title="Channel settings"
          >
            <GearIcon size={16} aria-hidden="true" />
          </button>
        </div>
      </SidebarContextMenu>

      {isVoice && voiceParticipants.length > 0 && (
        <div className="flex flex-col gap-0.5 py-0.5 pl-6">
          <MaybeStreamPreview
            enabled={showStreamPreview}
            channelId={channelId}
            channelName={channelName}
            sameChannel={isInSameChannel}
          >
            {voiceParticipants.map((p) => {
              const isSelf = p.userId === currentUserId;
              const el = (
                <SidebarVoiceParticipant
                  userId={p.userId}
                  isMuted={p.isMuted}
                  isDeafened={p.isDeafened}
                  isStreamingVideo={p.isStreamingVideo}
                  serverId={serverId}
                />
              );
              if (showStreamPreview && p.isStreamingVideo && !isSelf) {
                return (
                  <StreamPreviewTrigger key={p.userId} participantId={p.userId}>
                    {el}
                  </StreamPreviewTrigger>
                );
              }
              return <div key={p.userId}>{el}</div>;
            })}
          </MaybeStreamPreview>
        </div>
      )}
    </div>
  );
}

function MaybeStreamPreview({
  enabled,
  channelId,
  channelName,
  sameChannel,
  children,
}: {
  enabled: boolean;
  channelId: string;
  channelName: string;
  sameChannel: boolean;
  children: ReactNode;
}) {
  return enabled ? (
    <StreamPreviewTrackProvider
      channelId={channelId}
      channelName={channelName}
      sameChannel={sameChannel}
    >
      {children}
    </StreamPreviewTrackProvider>
  ) : (
    children
  );
}

function useSidebarSpeaking(userId: string): boolean {
  const currentUserId = useAuthStore((s) => s.user?.id);
  const isLocal = userId === currentUserId;
  const room = useMaybeRoomContext();
  const participant = room
    ? isLocal
      ? room.localParticipant
      : room.remoteParticipants.get(userId)
    : undefined;
  const localSpeaking = useLocalSpeaking();
  // useIsSpeaking throws without a participant or ParticipantContext,
  // so fall back to localParticipant (whose speaking state we ignore for remotes).
  const probedSpeaking = useIsSpeaking(participant ?? room?.localParticipant);
  if (!participant) return false;
  return isLocal ? localSpeaking : probedSpeaking;
}

function SidebarVoiceParticipant({
  userId,
  isMuted,
  isDeafened,
  isStreamingVideo,
  serverId,
}: {
  userId: string;
  isMuted: boolean;
  isDeafened: boolean;
  isStreamingVideo?: boolean;
  serverId?: string;
}) {
  const displayName = useDisplayName(userId, serverId);
  const avatarUrl = useUsersStore((s) => s.profiles[userId]?.avatarUrl);
  const isSpeaking = useSidebarSpeaking(userId);

  return (
    <div className="flex items-center gap-1.5 rounded-md px-2 py-1 text-text-muted hover:bg-bg-surface transition-colors">
      <div
        className={`rounded-full transition-shadow ${
          isSpeaking
            ? 'ring-[2px] ring-success shadow-[0_0_4px_rgba(0,196,118,0.4)]'
            : ''
        }`}
      >
        <Avatar avatarUrl={avatarUrl} displayName={displayName} size="xs" />
      </div>
      <span
        className={`flex-1 truncate text-xs transition-colors ${isSpeaking ? 'text-text' : ''}`}
      >
        {displayName}
      </span>
      {isStreamingVideo && (
        <span className="text-error" title="Sharing screen">
          <VideoCameraIcon weight="fill" size={14} aria-hidden="true" />
        </span>
      )}
      {isDeafened ? (
        <span title="Deafened">
          <EarSlashIcon size={14} className="text-error" aria-hidden="true" />
        </span>
      ) : (
        isMuted && (
          <span title="Muted">
            <MicrophoneSlashIcon
              size={14}
              className="text-text-subtle"
              aria-hidden="true"
            />
          </span>
        )
      )}
    </div>
  );
}
