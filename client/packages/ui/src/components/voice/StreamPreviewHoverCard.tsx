import type { TrackReference } from '@livekit/components-react';
import { useTracks, VideoTrack } from '@livekit/components-react';
import { useVoiceParticipantsStore, useVoiceStore } from '@meza/core';
import * as HoverCard from '@radix-ui/react-hover-card';
import { Track } from 'livekit-client';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  type PreviewStatus,
  useStreamPreview,
} from '../../hooks/useStreamPreview.ts';
import { useVoiceConnection } from '../../hooks/useVoiceConnection.ts';
import { useTilingStore } from '../../stores/tiling.ts';

const HOVER_OPEN_DELAY_MS = 400;
const HOVER_SWAP_DELAY_MS = 100;
const HOVER_CLOSE_DELAY_MS = 300;

const NOOP_GET_TRACK = () => undefined as TrackReference | undefined;

// ── Context ──────────────────────────────────────────────────────────

interface StreamPreviewContextValue {
  hoveredId: string | null;
  sameChannel: boolean;
  channelId: string;
  onEnter: (participantId: string) => void;
  onLeave: () => void;
  cancelClose: () => void;
  getTrackRef: (participantId: string) => TrackReference | undefined;
  onWatchStream: (participantId: string) => void;
  // Cross-channel preview state (only meaningful when sameChannel is false)
  previewStatus: PreviewStatus;
  previewVideoElement: HTMLVideoElement | null;
}

const StreamPreviewContext = createContext<StreamPreviewContextValue | null>(
  null,
);

// ── Shared hover timer logic ─────────────────────────────────────────

function useHoverState() {
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const openTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const closeTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const hoveredIdRef = useRef<string | null>(null);
  hoveredIdRef.current = hoveredId;

  useEffect(() => {
    return () => {
      clearTimeout(openTimeoutRef.current);
      clearTimeout(closeTimeoutRef.current);
    };
  }, []);

  const onEnter = useCallback((participantId: string) => {
    clearTimeout(closeTimeoutRef.current);
    clearTimeout(openTimeoutRef.current);
    const delay =
      hoveredIdRef.current !== null ? HOVER_SWAP_DELAY_MS : HOVER_OPEN_DELAY_MS;
    openTimeoutRef.current = setTimeout(() => {
      setHoveredId(participantId);
    }, delay);
  }, []);

  const onLeave = useCallback(() => {
    clearTimeout(openTimeoutRef.current);
    closeTimeoutRef.current = setTimeout(() => {
      setHoveredId(null);
    }, HOVER_CLOSE_DELAY_MS);
  }, []);

  const cancelClose = useCallback(() => {
    clearTimeout(closeTimeoutRef.current);
  }, []);

  return { hoveredId, setHoveredId, onEnter, onLeave, cancelClose };
}

// ── Same-channel provider ────────────────────────────────────────────

function useWatchStream(channelId: string, channelName: string) {
  const { connect: voiceConnect } = useVoiceConnection();

  return useCallback(
    async (participantId: string) => {
      // Only join if not already connected to this channel
      const voiceState = useVoiceStore.getState();
      if (
        voiceState.channelId !== channelId ||
        voiceState.status !== 'connected'
      ) {
        await voiceConnect(channelId, channelName);
      }

      // If a pane already shows this participant's stream, just focus it
      const store = useTilingStore.getState();
      for (const [paneId, pane] of Object.entries(store.panes)) {
        if (
          pane.type === 'screenShare' &&
          pane.channelId === channelId &&
          pane.participantIdentity === participantId
        ) {
          store.focusPane(paneId);
          return;
        }
      }

      // Look up display name from participants store
      const participants =
        useVoiceParticipantsStore.getState().byChannel[channelId];
      const participant = participants?.find((p) => p.userId === participantId);

      // Open a new screen share pane
      const content = {
        type: 'screenShare' as const,
        channelId,
        participantIdentity: participantId,
        participantName: participant?.userId,
      };

      try {
        store.splitFocused('horizontal', content);
      } catch {
        // At max panes — replace focused pane instead
        store.setPaneContent(store.focusedPaneId, content);
      }
    },
    [channelId, channelName, voiceConnect],
  );
}

function SameChannelProvider({
  channelId,
  channelName,
  children,
}: {
  channelId: string;
  channelName: string;
  children: ReactNode;
}) {
  const { hoveredId, setHoveredId, onEnter, onLeave, cancelClose } =
    useHoverState();
  const onWatchStream = useWatchStream(channelId, channelName);

  const allTracks = useTracks([Track.Source.ScreenShare]);
  const screenShareTracks = useMemo(
    () =>
      allTracks.filter((t): t is TrackReference => t.publication !== undefined),
    [allTracks],
  );

  const getTrackRef = useCallback(
    (participantId: string) =>
      screenShareTracks.find((t) => t.participant.identity === participantId),
    [screenShareTracks],
  );

  useEffect(() => {
    if (hoveredId && !getTrackRef(hoveredId)) {
      setHoveredId(null);
    }
  }, [hoveredId, getTrackRef, setHoveredId]);

  const contextValue = useMemo(
    () => ({
      hoveredId,
      sameChannel: true,
      channelId,
      onEnter,
      onLeave,
      cancelClose,
      getTrackRef,
      onWatchStream,
      previewStatus: 'idle' as PreviewStatus,
      previewVideoElement: null,
    }),
    [
      hoveredId,
      channelId,
      onEnter,
      onLeave,
      cancelClose,
      getTrackRef,
      onWatchStream,
    ],
  );

  return (
    <StreamPreviewContext.Provider value={contextValue}>
      {children}
    </StreamPreviewContext.Provider>
  );
}

// ── Cross-channel provider ───────────────────────────────────────────

function CrossChannelProvider({
  channelId,
  channelName,
  children,
}: {
  channelId: string;
  channelName: string;
  children: ReactNode;
}) {
  const { hoveredId, onEnter, onLeave, cancelClose } = useHoverState();
  const onWatchStream = useWatchStream(channelId, channelName);

  // Single preview connection shared across all triggers in this channel
  const preview = useStreamPreview();
  const { connect: previewConnect, disconnect: previewDisconnect } = preview;

  // Drive connect/disconnect from hoveredId changes
  useEffect(() => {
    if (hoveredId) {
      previewConnect(channelId, hoveredId);
    } else {
      previewDisconnect();
    }
    return () => {
      previewDisconnect();
    };
  }, [hoveredId, channelId, previewConnect, previewDisconnect]);

  const contextValue = useMemo(
    () => ({
      hoveredId,
      sameChannel: false,
      channelId,
      onEnter,
      onLeave,
      cancelClose,
      getTrackRef: NOOP_GET_TRACK,
      onWatchStream,
      previewStatus: preview.status,
      previewVideoElement: preview.videoElement,
    }),
    [
      hoveredId,
      channelId,
      onEnter,
      onLeave,
      cancelClose,
      onWatchStream,
      preview.status,
      preview.videoElement,
    ],
  );

  return (
    <StreamPreviewContext.Provider value={contextValue}>
      {children}
    </StreamPreviewContext.Provider>
  );
}

// ── Public provider facade ───────────────────────────────────────────

export function StreamPreviewTrackProvider({
  channelId,
  channelName,
  sameChannel,
  children,
}: {
  channelId: string;
  channelName: string;
  sameChannel: boolean;
  children: ReactNode;
}) {
  if (sameChannel) {
    return (
      <SameChannelProvider channelId={channelId} channelName={channelName}>
        {children}
      </SameChannelProvider>
    );
  }
  return (
    <CrossChannelProvider channelId={channelId} channelName={channelName}>
      {children}
    </CrossChannelProvider>
  );
}

// ── Trigger (wraps each streaming participant row) ───────────────────

export function StreamPreviewTrigger({
  participantId,
  children,
}: {
  participantId: string;
  children: ReactNode;
}) {
  const ctx = useContext(StreamPreviewContext);

  // Keep refs above the early return so hook count is stable
  const lastTrackRef = useRef<TrackReference | undefined>(undefined);

  if (!ctx) return <>{children}</>;

  const {
    hoveredId,
    sameChannel,
    onEnter,
    onLeave,
    cancelClose,
    getTrackRef,
    onWatchStream,
    previewStatus,
    previewVideoElement,
  } = ctx;
  const isOpen = hoveredId === participantId;

  // Same-channel: get track from primary room
  const trackRef =
    isOpen && sameChannel ? getTrackRef(participantId) : undefined;
  if (trackRef) lastTrackRef.current = trackRef;
  const displayTrackRef =
    trackRef ?? (isOpen && sameChannel ? lastTrackRef.current : undefined);

  const hasContent = sameChannel
    ? displayTrackRef !== undefined
    : isOpen &&
      (previewStatus === 'connected' || previewStatus === 'connecting');

  return (
    <HoverCard.Root open={isOpen && hasContent}>
      <HoverCard.Trigger asChild>
        {/* biome-ignore lint/a11y/noStaticElementInteractions: hover trigger for stream preview, no keyboard interaction needed */}
        <div onMouseEnter={() => onEnter(participantId)} onMouseLeave={onLeave}>
          {children}
        </div>
      </HoverCard.Trigger>
      <HoverCard.Portal>
        <HoverCard.Content
          side="right"
          sideOffset={8}
          collisionPadding={16}
          className="z-50 overflow-hidden rounded-lg border border-border bg-bg-overlay shadow-lg data-[state=open]:animate-scale-in data-[state=closed]:animate-scale-out"
          onPointerEnter={cancelClose}
          onPointerLeave={onLeave}
        >
          <WatchStreamWrapper onWatch={() => onWatchStream(participantId)}>
            {sameChannel && displayTrackRef ? (
              <SameChannelPreview trackRef={displayTrackRef} />
            ) : !sameChannel && isOpen ? (
              <CrossChannelPreview
                videoElement={previewVideoElement}
                status={previewStatus}
              />
            ) : null}
          </WatchStreamWrapper>
        </HoverCard.Content>
      </HoverCard.Portal>
    </HoverCard.Root>
  );
}

// ── Watch Stream overlay ─────────────────────────────────────────────

function WatchStreamWrapper({
  onWatch,
  children,
}: {
  onWatch: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onWatch}
      className="group relative cursor-pointer"
    >
      {children}
      <div className="absolute inset-0 flex items-center justify-center bg-black/0 transition-colors duration-150 group-hover:bg-black/50">
        <span className="text-sm font-medium text-white opacity-0 transition-opacity duration-150 group-hover:opacity-100">
          Watch Stream
        </span>
      </div>
    </button>
  );
}

// ── Preview content components ───────────────────────────────────────

function SameChannelPreview({ trackRef }: { trackRef: TrackReference }) {
  return (
    <div className="relative aspect-video w-80 overflow-hidden bg-bg-overlay">
      <div className="absolute inset-0 animate-shimmer bg-gradient-to-r from-bg-overlay via-bg-hover to-bg-overlay bg-[length:200%_100%]" />
      <VideoTrack
        trackRef={trackRef}
        className="absolute inset-0 h-full w-full object-contain"
      />
    </div>
  );
}

function CrossChannelPreview({
  videoElement,
  status,
}: {
  videoElement: HTMLVideoElement | null;
  status: PreviewStatus;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !videoElement) return;

    videoElement.className = 'absolute inset-0 h-full w-full object-contain';
    container.appendChild(videoElement);

    return () => {
      if (container.contains(videoElement)) {
        container.removeChild(videoElement);
      }
      videoElement.pause();
      videoElement.srcObject = null;
    };
  }, [videoElement]);

  return (
    <div
      ref={containerRef}
      className="relative aspect-video w-80 overflow-hidden bg-bg-overlay"
    >
      {status !== 'connected' && (
        <div className="absolute inset-0 animate-shimmer bg-gradient-to-r from-bg-overlay via-bg-hover to-bg-overlay bg-[length:200%_100%]" />
      )}
      {status === 'error' && (
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="text-xs text-text-muted">Preview unavailable</span>
        </div>
      )}
    </div>
  );
}
