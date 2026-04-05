import type { PaneContent } from '@meza/core';
import { hideKeyboard, useChannelStore, useVoiceStore } from '@meza/core';
import {
  ArrowLeftIcon,
  IconContext,
  MagnifyingGlassIcon,
  PushPinIcon,
  UsersIcon,
} from '@phosphor-icons/react';
import { useCallback, useEffect, useState } from 'react';
import { useMobileHistory } from '../../hooks/useMobileHistory.ts';
import { useNavigationStore } from '../../stores/navigation.ts';
import { useTilingStore } from '../../stores/tiling.ts';
import { ChannelView } from '../chat/ChannelView.tsx';
import { FriendsPane } from '../chat/FriendsPane.tsx';
import { ImageViewer } from '../chat/ImageViewer.tsx';
import { MemberList } from '../chat/MemberList.tsx';
import { MessageRequestsPane } from '../chat/MessageRequestsPane.tsx';
import { SearchPane } from '../chat/SearchPane.tsx';
import { CreateServerWizard } from '../onboarding/CreateServerWizard.tsx';
import { GetStartedView } from '../onboarding/GetStartedView.tsx';
import { ServerOnboardingView } from '../onboarding/ServerOnboardingView.tsx';
import { ProfileView } from '../profile/ProfileView.tsx';
import { CategoryPermissionsView } from '../settings/CategoryPermissionsView.tsx';
import { ChannelSettingsView } from '../settings/ChannelSettingsView.tsx';
import { ServerSettingsView } from '../settings/ServerSettingsView.tsx';
import { SettingsView } from '../settings/SettingsView.tsx';
import { MobileVoiceBar } from '../voice/MobileVoiceBar.tsx';
import { PersistentVoiceConnection } from '../voice/PersistentVoiceConnection.tsx';
import { ScreenSharePane } from '../voice/ScreenSharePane.tsx';
import { VoicePanel } from '../voice/VoicePanel.tsx';
import { GatewayConnectionBanner } from './GatewayConnectionBanner.tsx';
import { MobileOverlay } from './MobileOverlay.tsx';
import { MobileSlideOver } from './MobileSlideOver.tsx';
import { Sidebar } from './Sidebar.tsx';
import { ToastContainer } from './ToastContainer.tsx';

/**
 * Top-level mobile layout component. Renders instead of Shell on viewports < 768px.
 *
 * Structure:
 * - Base layer: Sidebar (server rail + channel list + footer)
 * - Slide-over layer: Channel/DM content (slides in from right)
 * - Voice fullscreen: Full-screen voice view
 * - Overlays: Member list, pinned messages, search, settings
 */
export function MobileShell() {
  const mobileActiveChannel = useNavigationStore((s) => s.mobileActiveChannel);
  const mobileOverlay = useNavigationStore((s) => s.mobileOverlay);
  const mobileVoiceFullscreen = useNavigationStore(
    (s) => s.mobileVoiceFullscreen,
  );
  const openMobileChannel = useNavigationStore((s) => s.openMobileChannel);
  const closeMobileChannel = useNavigationStore((s) => s.closeMobileChannel);
  const closeMobileOverlay = useNavigationStore((s) => s.closeMobileOverlay);
  const openMobileOverlay = useNavigationStore((s) => s.openMobileOverlay);
  const openMobileVoice = useNavigationStore((s) => s.openMobileVoice);
  const closeMobileVoice = useNavigationStore((s) => s.closeMobileVoice);

  // Sync browser history for Android back button
  useMobileHistory();

  // Dismiss any keyboard lingering from previous views (e.g. login form).
  // Android WebView doesn't always close the keyboard when inputs unmount.
  useEffect(() => {
    hideKeyboard();
  }, []);

  // Auto-close voice fullscreen when user disconnects
  const voiceStatus = useVoiceStore((s) => s.status);
  useEffect(() => {
    if (voiceStatus === 'idle' && mobileVoiceFullscreen) {
      closeMobileVoice();
    }
  }, [voiceStatus, mobileVoiceFullscreen, closeMobileVoice]);

  // Pins toggle state for channel view
  const [showPins, setShowPins] = useState(false);

  // Subscribe to tiling store: when Sidebar changes pane content, auto-open slide-over
  useEffect(() => {
    const unsub = useTilingStore.subscribe((state, prev) => {
      const content = state.panes[state.focusedPaneId];
      const prevContent = prev.panes[prev.focusedPaneId];
      if (content === prevContent) return;
      if (!content || content.type === 'empty') return;

      // Route to appropriate mobile UI based on content type
      if (content.type === 'voice') {
        openMobileVoice();
      } else {
        openMobileChannel(content);
      }
    });
    return unsub;
  }, [openMobileChannel, openMobileVoice]);

  // Subscribe to tiling overlay: when settings/profile overlay opens, route to mobile overlay
  useEffect(() => {
    const unsub = useTilingStore.subscribe((state, prev) => {
      if (state.overlayContent && !prev.overlayContent) {
        if (state.overlayContent.type === 'settings') {
          openMobileOverlay('settings');
          useTilingStore.getState().closeOverlay();
        }
        // Profile and settings overlays use the slide-over
        if (
          state.overlayContent.type === 'profile' ||
          state.overlayContent.type === 'channelSettings' ||
          state.overlayContent.type === 'serverSettings' ||
          state.overlayContent.type === 'categoryPermissions'
        ) {
          openMobileChannel(state.overlayContent);
          useTilingStore.getState().closeOverlay();
        }
      }
    });
    return unsub;
  }, [openMobileOverlay, openMobileChannel]);

  const handleBack = useCallback(() => {
    closeMobileChannel();
    setShowPins(false);
  }, [closeMobileChannel]);

  return (
    <IconContext.Provider value={{ weight: 'fill' }}>
      <div className="flex min-h-0 w-full flex-1 flex-col overflow-hidden bg-bg-base safe-top safe-bottom">
        <GatewayConnectionBanner />
        <PersistentVoiceConnection>
          <div className="relative flex min-h-0 flex-1">
            {/* Base layer: sidebar (server rail + channel list) */}
            <Sidebar style={{ width: '100%' }} />

            {/* Slide-over layer: channel / DM content */}
            <MobileSlideOver open={!!mobileActiveChannel} onClose={handleBack}>
              {mobileActiveChannel && (
                <MobileChannelContent
                  content={mobileActiveChannel}
                  onBack={handleBack}
                  showPins={showPins}
                  onTogglePins={() => setShowPins((p) => !p)}
                  onOpenMembers={() => openMobileOverlay('members')}
                  onOpenSearch={() => openMobileOverlay('search')}
                />
              )}
            </MobileSlideOver>

            {/* Voice fullscreen */}
            <MobileSlideOver
              open={mobileVoiceFullscreen}
              onClose={closeMobileVoice}
            >
              <MobileVoiceFullscreen onClose={closeMobileVoice} />
            </MobileSlideOver>
          </div>
        </PersistentVoiceConnection>

        {/* Full-screen overlays */}
        <MobileOverlay
          open={mobileOverlay === 'members'}
          onClose={closeMobileOverlay}
          title="Members"
        >
          {mobileActiveChannel && resolveServerId(mobileActiveChannel) ? (
            <MemberList serverId={resolveServerId(mobileActiveChannel) ?? ''} />
          ) : (
            <div className="flex flex-1 items-center justify-center text-text-muted text-sm">
              No server selected
            </div>
          )}
        </MobileOverlay>

        <MobileOverlay
          open={mobileOverlay === 'pins'}
          onClose={closeMobileOverlay}
          title="Pinned Messages"
        >
          <MobileOverlayPlaceholder label="Pinned Messages" />
        </MobileOverlay>

        <MobileOverlay
          open={mobileOverlay === 'search'}
          onClose={closeMobileOverlay}
          title="Search"
        >
          {mobileActiveChannel?.type === 'channel' ? (
            <SearchPane channelId={mobileActiveChannel.channelId} />
          ) : (
            <SearchPane />
          )}
        </MobileOverlay>

        <MobileOverlay
          open={mobileOverlay === 'settings'}
          onClose={closeMobileOverlay}
          title="Settings"
        >
          <SettingsView />
        </MobileOverlay>

        <ImageViewer />
        <ToastContainer />
      </div>
    </IconContext.Provider>
  );
}

// ── Channel content with mobile header ──

function MobileChannelContent({
  content,
  onBack,
  showPins,
  onTogglePins,
  onOpenMembers,
  onOpenSearch,
}: {
  content: PaneContent;
  onBack: () => void;
  showPins: boolean;
  onTogglePins: () => void;
  onOpenMembers: () => void;
  onOpenSearch: () => void;
}) {
  const channelName = useContentLabel(content);

  return (
    <div className="flex flex-1 min-h-0 flex-col">
      {/* Mobile channel header */}
      <header className="flex h-12 flex-shrink-0 items-center gap-2 border-b border-border/40 px-2">
        <button
          type="button"
          onClick={onBack}
          className="p-2 text-text-muted hover:text-text transition-colors"
          aria-label="Back"
        >
          <ArrowLeftIcon size={20} aria-hidden="true" />
        </button>
        <h2 className="flex-1 truncate text-base font-semibold text-text">
          {channelName}
        </h2>

        {/* Toolbar: only show for channel/dm types */}
        {(content.type === 'channel' || content.type === 'dm') && (
          <div className="flex items-center">
            <button
              type="button"
              onClick={onOpenSearch}
              className="p-2 text-text-muted hover:text-text transition-colors"
              aria-label="Search"
            >
              <MagnifyingGlassIcon size={20} aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={onTogglePins}
              className={`p-2 transition-colors ${showPins ? 'text-accent' : 'text-text-muted hover:text-text'}`}
              aria-label="Pinned messages"
            >
              <PushPinIcon size={20} aria-hidden="true" />
            </button>
            {content.type === 'channel' && (
              <button
                type="button"
                onClick={onOpenMembers}
                className="p-2 text-text-muted hover:text-text transition-colors"
                aria-label="Members"
              >
                <UsersIcon size={20} aria-hidden="true" />
              </button>
            )}
          </div>
        )}
      </header>

      {/* Voice connection banner */}
      <MobileVoiceBar />

      {/* Content */}
      <div className="flex flex-1 min-h-0 min-w-0 flex-col">
        {renderMobileContent(content, { showPins, onTogglePins })}
      </div>
    </div>
  );
}

// ── Voice fullscreen ──

function MobileVoiceFullscreen({ onClose }: { onClose: () => void }) {
  // Primary source: the voice store knows which channel we're actually connected to
  const voiceStoreChannelId = useVoiceStore((s) => s.channelId);
  const channelId = useNavigationStore((s) => {
    const content = s.mobileActiveChannel;
    if (content?.type === 'voice') return content.channelId;
    return null;
  });
  const voiceChannelId = useTilingStore((s) => {
    for (const content of Object.values(s.panes)) {
      if (content.type === 'voice') return content.channelId;
    }
    return null;
  });

  const activeChannelId = voiceStoreChannelId || channelId || voiceChannelId;

  return (
    <div className="flex flex-1 min-h-0 flex-col">
      <header className="flex h-12 flex-shrink-0 items-center gap-2 border-b border-border/40 px-2">
        <button
          type="button"
          onClick={onClose}
          className="p-2 text-text-muted hover:text-text transition-colors"
          aria-label="Close voice"
        >
          <ArrowLeftIcon size={20} aria-hidden="true" />
        </button>
        <h2 className="flex-1 truncate text-base font-semibold text-text">
          Voice
        </h2>
      </header>
      <div className="flex flex-1 min-h-0 min-w-0 flex-col">
        {activeChannelId ? (
          <VoicePanel channelId={activeChannelId} />
        ) : (
          <div className="flex flex-1 items-center justify-center text-text-muted">
            Not connected to voice
          </div>
        )}
      </div>
    </div>
  );
}

// ── Content rendering (mirrors ContentArea.renderPaneContent) ──

function renderMobileContent(
  content: PaneContent,
  opts: { showPins?: boolean; onTogglePins?: () => void },
): React.ReactNode {
  const serverId = resolveServerId(content);
  const paneId = useTilingStore.getState().focusedPaneId;

  switch (content.type) {
    case 'channel':
      return (
        <ChannelView
          channelId={content.channelId}
          showPins={opts.showPins}
          serverId={serverId}
          onTogglePins={opts.onTogglePins}
        />
      );
    case 'dm':
      return <ChannelView channelId={content.conversationId} />;
    case 'voice':
      return <VoicePanel channelId={content.channelId} />;
    case 'screenShare':
      return (
        <ScreenSharePane
          paneId={paneId}
          participantIdentity={content.participantIdentity}
          channelId={content.channelId}
        />
      );
    case 'settings':
      return <SettingsView section={content.section} />;
    case 'serverSettings':
      return <ServerSettingsView serverId={content.serverId} />;
    case 'channelSettings':
      return (
        <ChannelSettingsView
          serverId={content.serverId}
          channelId={content.channelId}
        />
      );
    case 'categoryPermissions':
      return (
        <CategoryPermissionsView
          serverId={content.serverId}
          channelGroupId={content.channelGroupId}
        />
      );
    case 'profile':
      return (
        <ProfileView userId={content.userId} initialEditing={content.editing} />
      );
    case 'serverOnboarding':
      return <ServerOnboardingView serverId={content.serverId} />;
    case 'getStarted':
      return <GetStartedView paneId={paneId} />;
    case 'createServer':
      return <CreateServerWizard paneId={paneId} />;
    case 'messageRequests':
      return <MessageRequestsPane />;
    case 'friends':
      return <FriendsPane tab={content.tab} />;
    case 'search':
      return (
        <SearchPane
          initialQuery={content.query}
          serverId={serverId}
          channelId={content.channelId}
        />
      );
    default:
      return null;
  }
}

function resolveServerId(content: PaneContent): string | undefined {
  if ('serverId' in content && content.serverId) return content.serverId;
  if ('channelId' in content && content.channelId) {
    return useChannelStore.getState().channelToServer[content.channelId];
  }
  return undefined;
}

// ── Helpers ──

function useContentLabel(content: PaneContent): string {
  const channels = useChannelStore((s) => s.byServer);

  switch (content.type) {
    case 'channel': {
      for (const chs of Object.values(channels)) {
        const ch = chs?.find((c) => c.id === content.channelId);
        if (ch) return `# ${ch.name}`;
      }
      return '# channel';
    }
    case 'dm':
      return 'DM';
    case 'voice':
      return 'Voice';
    case 'settings':
      return 'Settings';
    case 'serverSettings':
      return 'Server Settings';
    case 'channelSettings':
      return 'Channel Settings';
    case 'categoryPermissions':
      return 'Category Permissions';
    case 'profile':
      return 'Profile';
    case 'search':
      return 'Search';
    case 'serverOnboarding':
      return 'Welcome';
    case 'getStarted':
      return 'Get Started';
    case 'createServer':
      return 'Create Server';
    case 'messageRequests':
      return 'Message Requests';
    case 'friends':
      return 'Friends';
    case 'screenShare':
      return 'Screen Share';
    case 'dmsHome':
      return 'Messages';
    case 'empty':
      return '';
  }
}

function MobileOverlayPlaceholder({ label }: { label: string }) {
  return (
    <div className="flex flex-1 items-center justify-center text-text-muted text-sm">
      {label} panel coming soon
    </div>
  );
}
