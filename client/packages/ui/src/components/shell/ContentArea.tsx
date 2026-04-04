import { DragOverlay } from '@dnd-kit/core';
import type { DMChannel, DropPosition, PaneContent, PaneId } from '@meza/core';
import {
  ChannelType,
  getDMDisplayName,
  hasPermission,
  isGroupDM,
  Permissions,
  paneCount,
  useAuthStore,
  useChannelGroupStore,
  useChannelStore,
  useDMStore,
  useMemberStore,
  useRoleStore,
  useServerStore,
} from '@meza/core';
import {
  AtIcon,
  BookOpenIcon,
  ChatCircleDotsIcon,
  EnvelopeOpenIcon,
  GearIcon,
  HashIcon,
  MagnifyingGlassIcon,
  MonitorIcon,
  RocketIcon,
  SparkleIcon,
  SpeakerHighIcon,
  UserIcon,
  UsersThreeIcon,
  XIcon,
} from '@phosphor-icons/react';
import { useCallback, useMemo, useState } from 'react';
import { resolveDisplayName } from '../../hooks/useDisplayName.ts';
import { useNavigationStore } from '../../stores/navigation.ts';
import {
  openChannelSettingsPane,
  useTilingStore,
} from '../../stores/tiling.ts';
import { ChannelView } from '../chat/ChannelView.tsx';
import { FriendsPane } from '../chat/FriendsPane.tsx';
import { MessageRequestsPane } from '../chat/MessageRequestsPane.tsx';
import { SearchPane } from '../chat/SearchPane.tsx';
import { DMsHomePane } from '../dm/DMsHomePane.tsx';
import { CreateServerWizard } from '../onboarding/CreateServerWizard.tsx';
import { GetStartedView } from '../onboarding/GetStartedView.tsx';
import { ServerOnboardingView } from '../onboarding/ServerOnboardingView.tsx';
import { ProfileView } from '../profile/ProfileView.tsx';
import { CategoryPermissionsView } from '../settings/CategoryPermissionsView.tsx';
import { ChannelSettingsView } from '../settings/ChannelSettingsView.tsx';
import { ServerSettingsView } from '../settings/ServerSettingsView.tsx';
import { SettingsView } from '../settings/SettingsView.tsx';
import { ScreenSharePane } from '../voice/ScreenSharePane.tsx';
import { VoicePanel } from '../voice/VoicePanel.tsx';
import { AppUpdateBanner } from './AppUpdateBanner.tsx';
import { GatewayConnectionBanner } from './GatewayConnectionBanner.tsx';
import { Pane } from './Pane.tsx';
import { PaneSlot } from './PaneSlot.tsx';
import { TilingRenderer } from './TilingRenderer.tsx';

interface PaneMeta {
  label: string;
  serverName?: string;
  serverId?: string;
  serverIconUrl?: string;
}

function paneMeta(
  content: PaneContent,
  channelsByServer: Record<string, readonly { id: string; name: string }[]>,
  servers: Record<string, { name: string; iconUrl?: string }>,
  dmChannels: DMChannel[],
  currentUserId: string | undefined,
  channelGroupsByServer?: Record<
    string,
    readonly { id: string; name: string }[]
  >,
): PaneMeta {
  switch (content.type) {
    case 'channel':
    case 'voice': {
      for (const [serverId, channels] of Object.entries(channelsByServer)) {
        const match = channels.find((c) => c.id === content.channelId);
        if (match) {
          return {
            label: match.name,
            serverName: servers[serverId]?.name,
            serverIconUrl: servers[serverId]?.iconUrl,
            serverId,
          };
        }
      }
      return { label: content.channelId };
    }
    case 'screenShare': {
      for (const [serverId, channels] of Object.entries(channelsByServer)) {
        const match = channels.find((c) => c.id === content.channelId);
        if (match) {
          const displayName = resolveDisplayName(
            content.participantIdentity,
            serverId,
          );
          return {
            label: `Screen Share — ${displayName}`,
            serverName: servers[serverId]?.name,
            serverIconUrl: servers[serverId]?.iconUrl,
            serverId,
          };
        }
      }
      const displayName = resolveDisplayName(content.participantIdentity);
      return { label: `Screen Share — ${displayName}` };
    }
    case 'dm': {
      const dm = dmChannels.find(
        (d: DMChannel) => d.channel?.id === content.conversationId,
      );
      if (dm) {
        return { label: getDMDisplayName(dm, currentUserId ?? '') };
      }
      return { label: 'DM' };
    }
    case 'settings':
      return { label: content.section ?? 'Settings' };
    case 'profile': {
      return {
        label: resolveDisplayName(content.userId),
      };
    }
    case 'search':
      return { label: content.query ?? 'Search' };
    case 'serverSettings':
      return {
        label: 'Server Settings',
        serverName: servers[content.serverId]?.name,
        serverIconUrl: servers[content.serverId]?.iconUrl,
        serverId: content.serverId,
      };
    case 'channelSettings': {
      const chs = channelsByServer[content.serverId];
      const ch = chs?.find((c) => c.id === content.channelId);
      return {
        label: ch ? `${ch.name} — Channel Settings` : 'Channel Settings',
        serverName: servers[content.serverId]?.name,
        serverIconUrl: servers[content.serverId]?.iconUrl,
        serverId: content.serverId,
      };
    }
    case 'categoryPermissions': {
      const cgs = channelGroupsByServer?.[content.serverId];
      const cg = cgs?.find((g) => g.id === content.channelGroupId);
      return {
        label: cg ? `${cg.name} — Settings` : 'Category Settings',
        serverName: servers[content.serverId]?.name,
        serverIconUrl: servers[content.serverId]?.iconUrl,
        serverId: content.serverId,
      };
    }
    case 'serverOnboarding':
      return {
        label: 'Welcome',
        serverName: servers[content.serverId]?.name,
        serverIconUrl: servers[content.serverId]?.iconUrl,
        serverId: content.serverId,
      };
    case 'getStarted':
      return { label: 'Get Started' };
    case 'createServer':
      return { label: 'Create a Server' };
    case 'messageRequests':
      return { label: 'Message Requests' };
    case 'friends':
      return { label: 'Friends' };
    case 'dmsHome':
      return { label: 'Messages' };
    case 'empty':
      return { label: 'Empty' };
  }
}

function renderPaneContent(
  content: PaneContent,
  opts: {
    paneId: PaneId;
    showMembers?: boolean;
    showPins?: boolean;
    serverId?: string;
    onTogglePins?: () => void;
  },
): React.ReactNode {
  switch (content.type) {
    case 'channel':
      return (
        <ChannelView
          channelId={content.channelId}
          showMembers={opts.showMembers}
          showPins={opts.showPins}
          serverId={opts.serverId}
          onTogglePins={opts.onTogglePins}
        />
      );
    case 'settings':
      return <SettingsView section={content.section} />;
    case 'serverSettings':
      return <ServerSettingsView serverId={content.serverId} />;
    case 'channelSettings':
      return (
        <div className="flex min-h-0 min-w-0 flex-1">
          <ChannelSettingsView
            serverId={content.serverId}
            channelId={content.channelId}
          />
        </div>
      );
    case 'categoryPermissions':
      return (
        <div className="flex min-h-0 min-w-0 flex-1">
          <CategoryPermissionsView
            serverId={content.serverId}
            channelGroupId={content.channelGroupId}
          />
        </div>
      );
    case 'voice':
      return <VoicePanel channelId={content.channelId} />;
    case 'screenShare':
      return (
        <ScreenSharePane
          paneId={opts.paneId}
          participantIdentity={content.participantIdentity}
          channelId={content.channelId}
        />
      );
    case 'dm':
      return <ChannelView channelId={content.conversationId} />;
    case 'profile':
      return (
        <ProfileView userId={content.userId} initialEditing={content.editing} />
      );
    case 'serverOnboarding':
      return <ServerOnboardingView serverId={content.serverId} />;
    case 'getStarted':
      return <GetStartedView paneId={opts.paneId} />;
    case 'createServer':
      return <CreateServerWizard paneId={opts.paneId} />;
    case 'messageRequests':
      return <MessageRequestsPane />;
    case 'friends':
      return <FriendsPane tab={content.tab} />;
    case 'dmsHome':
      return <DMsHomePane paneId={opts.paneId} />;
    case 'search':
      return (
        <SearchPane
          initialQuery={content.query}
          serverId={opts.serverId}
          channelId={content.channelId}
        />
      );
    default:
      return null;
  }
}

function paneIcon(
  content: PaneContent,
  dmChannels?: DMChannel[],
): React.ReactNode {
  const sm = { size: 12 } as const;
  switch (content.type) {
    case 'channel':
      return <HashIcon weight="regular" {...sm} aria-hidden="true" />;
    case 'dm': {
      const dm = dmChannels?.find(
        (d) => d.channel?.id === content.conversationId,
      );
      return dm && isGroupDM(dm) ? (
        <UsersThreeIcon {...sm} aria-hidden="true" />
      ) : (
        <AtIcon {...sm} aria-hidden="true" />
      );
    }
    case 'voice':
      return <SpeakerHighIcon {...sm} aria-hidden="true" />;
    case 'screenShare':
      return <MonitorIcon {...sm} aria-hidden="true" />;
    case 'settings':
    case 'serverSettings':
    case 'channelSettings':
    case 'categoryPermissions':
      return <GearIcon {...sm} aria-hidden="true" />;
    case 'profile':
      return <UserIcon {...sm} aria-hidden="true" />;
    case 'search':
      return <MagnifyingGlassIcon {...sm} aria-hidden="true" />;
    case 'serverOnboarding':
      return <BookOpenIcon {...sm} aria-hidden="true" />;
    case 'getStarted':
      return <RocketIcon {...sm} aria-hidden="true" />;
    case 'createServer':
      return <SparkleIcon {...sm} aria-hidden="true" />;
    case 'messageRequests':
      return <EnvelopeOpenIcon {...sm} aria-hidden="true" />;
    case 'friends':
      return <UsersThreeIcon {...sm} aria-hidden="true" />;
    case 'dmsHome':
      return <ChatCircleDotsIcon {...sm} aria-hidden="true" />;
    case 'empty':
      return <HashIcon weight="regular" {...sm} aria-hidden="true" />;
  }
}

export function ContentArea({
  resizeHandle,
  activeDragPaneId,
  sidebarDragContent,
  sidebarDragLabel,
  overPaneId,
  activeDropZone,
}: {
  resizeHandle?: React.ReactNode;
  activeDragPaneId: string | null;
  sidebarDragContent: PaneContent | null;
  sidebarDragLabel: string | null;
  overPaneId: string | null;
  activeDropZone: DropPosition | null;
}) {
  const root = useTilingStore((s) => s.root);
  const focusedPaneId = useTilingStore((s) => s.focusedPaneId);
  const panes = useTilingStore((s) => s.panes);
  const focusPane = useTilingStore((s) => s.focusPane);
  const closePane = useTilingStore((s) => s.closePane);
  const paneCountInTree = useTilingStore((s) => paneCount(s.root));
  const channelsByServer = useChannelStore((s) => s.byServer);
  const channelGroupsByServer = useChannelGroupStore((s) => s.byServer);
  const servers = useServerStore((s) => s.servers);
  const dmChannels = useDMStore((s) => s.dmChannels);
  const currentUserId = useAuthStore((s) => s.user?.id);
  const selectedServerId = useNavigationStore((s) => s.selectedServerId);
  const selectServer = useNavigationStore((s) => s.selectServer);

  // Compute MANAGE_CHANNELS permission per server for the current user.
  // This drives the channel-settings gear icon visibility in pane headers.
  const membersByServer = useMemberStore((s) => s.byServer);
  const rolesByServer = useRoleStore((s) => s.byServer);
  const allServers = useServerStore((s) => s.servers);

  const canManageChannelsPerServer = useMemo(() => {
    if (!currentUserId) return {} as Record<string, boolean>;
    const result: Record<string, boolean> = {};
    for (const serverId of Object.keys(channelsByServer)) {
      const owner = allServers[serverId]?.ownerId;
      if (owner && currentUserId === owner) {
        result[serverId] = true;
        continue;
      }
      const member = membersByServer[serverId]?.find(
        (m) => m.userId === currentUserId,
      );
      if (!member) {
        result[serverId] = false;
        continue;
      }
      const roles = rolesByServer[serverId];
      if (!roles) {
        result[serverId] = false;
        continue;
      }
      let combined = 0n;
      for (const role of roles) {
        if (member.roleIds.includes(role.id)) combined |= role.permissions;
      }
      result[serverId] =
        hasPermission(combined, Permissions.MANAGE_CHANNELS) ||
        hasPermission(combined, Permissions.MANAGE_ROLES);
    }
    return result;
  }, [
    currentUserId,
    channelsByServer,
    allServers,
    membersByServer,
    rolesByServer,
  ]);

  const dragDisabled = paneCountInTree <= 1;

  const [memberPanels, setMemberPanels] = useState<Record<PaneId, boolean>>({});
  const [pinPanels, setPinPanels] = useState<Record<PaneId, boolean>>({});

  const toggleMembers = useCallback((paneId: PaneId) => {
    setMemberPanels((prev) => ({ ...prev, [paneId]: !prev[paneId] }));
  }, []);

  const togglePins = useCallback((paneId: PaneId) => {
    setPinPanels((prev) => ({ ...prev, [paneId]: !prev[paneId] }));
  }, []);

  const renderPane = useCallback(
    (paneId: PaneId) => {
      const rawContent = panes[paneId] ?? { type: 'empty' as const };
      let content = rawContent;
      // Resolve empty panes to the first text channel of the selected server
      if (content.type === 'empty' && selectedServerId) {
        const channels = channelsByServer[selectedServerId];
        const firstText = channels?.find((c) => c.type === ChannelType.TEXT);
        if (firstText) {
          content = { type: 'channel', channelId: firstText.id };
        }
      }
      const isDefaultFallback =
        rawContent.type === 'empty' && content.type !== 'empty';
      const meta = paneMeta(
        content,
        channelsByServer,
        servers,
        dmChannels,
        currentUserId,
        channelGroupsByServer,
      );
      const isChannel = content.type === 'channel';
      const canManageThisChannel =
        isChannel &&
        !!meta.serverId &&
        !!canManageChannelsPerServer[meta.serverId];
      const showMembers = isChannel && !!memberPanels[paneId];
      const showPins = isChannel && !!pinPanels[paneId];
      const children = renderPaneContent(content, {
        paneId,
        showMembers,
        showPins,
        serverId: meta.serverId,
        onTogglePins: isChannel ? () => togglePins(paneId) : undefined,
      });
      const isSource = activeDragPaneId === paneId;
      const isTarget =
        overPaneId === paneId && (sidebarDragContent ? true : !isSource);
      const dropZone = isTarget ? activeDropZone : null;

      return (
        <PaneSlot paneId={paneId} isDragging={isSource && !sidebarDragContent}>
          <Pane
            paneId={paneId}
            label={meta.label}
            icon={paneIcon(content, dmChannels)}
            focused={paneId === focusedPaneId}
            showClose={
              paneCountInTree > 1 ||
              (content.type !== 'empty' && !isDefaultFallback)
            }
            onClose={() => closePane(paneId)}
            onFocus={() => focusPane(paneId)}
            serverName={meta.serverName}
            serverIconUrl={meta.serverIconUrl}
            onServerClick={
              // biome-ignore lint/style/noNonNullAssertion: guarded by truthy check on meta.serverId
              meta.serverId ? () => selectServer(meta.serverId!) : undefined
            }
            onToggleMembers={
              isChannel ? () => toggleMembers(paneId) : undefined
            }
            showMembers={showMembers}
            onTogglePins={isChannel ? () => togglePins(paneId) : undefined}
            showPins={showPins}
            onOpenChannelSettings={
              canManageThisChannel && content.type === 'channel'
                ? () =>
                    // biome-ignore lint/style/noNonNullAssertion: guarded by canManageThisChannel which checks meta.serverId
                    openChannelSettingsPane(meta.serverId!, content.channelId)
                : undefined
            }
            isDragSource={isSource}
            dropZone={dropZone}
            dragDisabled={dragDisabled}
          >
            {children}
          </Pane>
        </PaneSlot>
      );
    },
    [
      panes,
      focusedPaneId,
      paneCountInTree,
      closePane,
      focusPane,
      channelsByServer,
      servers,
      dmChannels,
      currentUserId,
      selectedServerId,
      selectServer,
      canManageChannelsPerServer,
      memberPanels,
      toggleMembers,
      pinPanels,
      togglePins,
      activeDragPaneId,
      sidebarDragContent,
      overPaneId,
      activeDropZone,
      dragDisabled,
      channelGroupsByServer,
    ],
  );

  const overlayContent = useTilingStore((s) => s.overlayContent);
  const closeOverlay = useTilingStore((s) => s.closeOverlay);

  // Resolve content for the drag overlay pill
  const dragContent = activeDragPaneId ? panes[activeDragPaneId] : null;
  const dragMeta =
    dragContent && activeDragPaneId
      ? paneMeta(
          dragContent,
          channelsByServer,
          servers,
          dmChannels,
          currentUserId,
        )
      : null;

  // Overlay label for sidebar drags
  const sidebarDragMeta = sidebarDragContent
    ? paneMeta(
        sidebarDragContent,
        channelsByServer,
        servers,
        dmChannels,
        currentUserId,
      )
    : null;

  return (
    <main className="relative flex flex-1 flex-col min-h-0 min-w-0 bg-bg-overlay">
      {resizeHandle}
      <GatewayConnectionBanner />
      <AppUpdateBanner />
      <div className="flex flex-1 min-h-0 min-w-0 p-1.5">
        <TilingRenderer node={root} renderPane={renderPane} />
      </div>
      <DragOverlay dropAnimation={null}>
        {activeDragPaneId && dragMeta && dragContent ? (
          <div className="flex items-center gap-2 rounded-lg bg-bg-surface px-3 py-1.5 text-sm font-medium text-text shadow-lg border border-border">
            <span className="text-text-subtle">
              {paneIcon(dragContent, dmChannels)}
            </span>
            <span className="truncate max-w-48">{dragMeta.label}</span>
          </div>
        ) : sidebarDragContent && sidebarDragMeta ? (
          <div className="flex items-center gap-2 rounded-lg bg-bg-surface px-3 py-1.5 text-sm font-medium text-text shadow-lg border border-border">
            <span className="text-text-subtle">
              {paneIcon(sidebarDragContent, dmChannels)}
            </span>
            <span className="truncate max-w-48">
              {sidebarDragLabel ?? sidebarDragMeta.label}
            </span>
          </div>
        ) : null}
      </DragOverlay>
      {overlayContent && (
        <OverlayPane content={overlayContent} onClose={closeOverlay} />
      )}
    </main>
  );
}

function OverlayPane({
  content,
  onClose,
}: {
  content: PaneContent;
  onClose: () => void;
}) {
  const dmChannels = useDMStore((s) => s.dmChannels);
  const channelsByServer = useChannelStore((s) => s.byServer);
  const channelGroupsByServer = useChannelGroupStore((s) => s.byServer);
  const servers = useServerStore((s) => s.servers);
  const currentUserId = useAuthStore((s) => s.user?.id);
  const meta = paneMeta(
    content,
    channelsByServer,
    servers,
    dmChannels,
    currentUserId,
    channelGroupsByServer,
  );
  const children = renderPaneContent(content, { paneId: '__overlay__' });

  return (
    <div className="absolute inset-0 z-10 flex flex-col m-1.5">
      <section className="flex flex-1 min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-border/40 shadow-md">
        <div className="flex flex-shrink-0 items-center gap-2.5 bg-bg-base px-4 h-10">
          <span className="text-text-subtle">{paneIcon(content)}</span>
          <span className="flex-1 truncate font-medium text-text-muted text-sm">
            {meta.label}
          </span>
          <button
            type="button"
            className="rounded-md p-1 text-text-subtle hover:bg-bg-elevated hover:text-text"
            onClick={onClose}
            aria-label={`Close ${meta.label}`}
          >
            <XIcon weight="regular" size={18} aria-hidden="true" />
          </button>
        </div>
        <div className="flex flex-1 flex-col min-h-0 overflow-hidden bg-bg-base">
          {children}
        </div>
      </section>
    </div>
  );
}
