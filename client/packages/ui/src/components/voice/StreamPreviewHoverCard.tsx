import * as HoverCard from '@radix-ui/react-hover-card';
import { useTracks, VideoTrack } from '@livekit/components-react';
import type { TrackReference } from '@livekit/components-react';
import { Track } from 'livekit-client';
import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useStreamPreview } from '../../hooks/useStreamPreview.ts';

const HOVER_OPEN_DELAY_MS = 400;
const HOVER_SWAP_DELAY_MS = 100;
const HOVER_CLOSE_DELAY_MS = 300;

interface StreamPreviewContextValue {
  hoveredId: string | null;
  sameChannel: boolean;
  channelId: string;
  onEnter: (participantId: string) => void;
  onLeave: () => void;
  cancelClose: () => void;
  getTrackRef: (participantId: string) => TrackReference | undefined;
}

const StreamPreviewContext = createContext<StreamPreviewContextValue | null>(
  null,
);

// Shared hover state logic used by both same-channel and cross-channel providers
function useHoverState() {
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const openTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const closeTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const mountedRef = useRef(true);
  const hoveredIdRef = useRef<string | null>(null);

  hoveredIdRef.current = hoveredId;

  useEffect(() => {
    return () => {
      mountedRef.current = false;
      clearTimeout(openTimeoutRef.current);
      clearTimeout(closeTimeoutRef.current);
    };
  }, []);

  const onEnter = useCallback((participantId: string) => {
    clearTimeout(closeTimeoutRef.current);
    clearTimeout(openTimeoutRef.current);
    const delay =
      hoveredIdRef.current !== null
        ? HOVER_SWAP_DELAY_MS
        : HOVER_OPEN_DELAY_MS;
    openTimeoutRef.current = setTimeout(() => {
      if (mountedRef.current) setHoveredId(participantId);
    }, delay);
  }, []);

  const onLeave = useCallback(() => {
    clearTimeout(openTimeoutRef.current);
    closeTimeoutRef.current = setTimeout(() => {
      if (mountedRef.current) setHoveredId(null);
    }, HOVER_CLOSE_DELAY_MS);
  }, []);

  const cancelClose = useCallback(() => {
    clearTimeout(closeTimeoutRef.current);
  }, []);

  return { hoveredId, setHoveredId, onEnter, onLeave, cancelClose };
}

/**
 * Same-channel provider: calls useTracks() from the primary LiveKit room.
 */
function SameChannelProvider({
  channelId,
  children,
}: {
  channelId: string;
  children: ReactNode;
}) {
  const { hoveredId, setHoveredId, onEnter, onLeave, cancelClose } =
    useHoverState();

  const allTracks = useTracks([Track.Source.ScreenShare]);
  const screenShareTracks = useMemo(
    () =>
      allTracks.filter(
        (t): t is TrackReference => t.publication !== undefined,
      ),
    [allTracks],
  );

  const getTrackRef = useCallback(
    (participantId: string) =>
      screenShareTracks.find(
        (t) => t.participant.identity === participantId,
      ),
    [screenShareTracks],
  );

  // Close popover when hovered track disappears (stream ended)
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
    }),
    [hoveredId, channelId, onEnter, onLeave, cancelClose, getTrackRef],
  );

  return (
    <StreamPreviewContext.Provider value={contextValue}>
      {children}
    </StreamPreviewContext.Provider>
  );
}

/**
 * Cross-channel provider: does NOT call useTracks(). Track access is handled
 * per-trigger via useStreamPreview.
 */
function CrossChannelProvider({
  channelId,
  children,
}: {
  channelId: string;
  children: ReactNode;
}) {
  const { hoveredId, onEnter, onLeave, cancelClose } = useHoverState();

  const noopGetTrackRef = useCallback(
    () => undefined as TrackReference | undefined,
    [],
  );

  const contextValue = useMemo(
    () => ({
      hoveredId,
      sameChannel: false,
      channelId,
      onEnter,
      onLeave,
      cancelClose,
      getTrackRef: noopGetTrackRef,
    }),
    [hoveredId, channelId, onEnter, onLeave, cancelClose, noopGetTrackRef],
  );

  return (
    <StreamPreviewContext.Provider value={contextValue}>
      {children}
    </StreamPreviewContext.Provider>
  );
}

/**
 * Public API: picks the correct provider based on whether the user is
 * connected to the same channel. This avoids conditionally calling useTracks().
 */
export function StreamPreviewTrackProvider({
  channelId,
  sameChannel,
  children,
}: {
  channelId: string;
  sameChannel: boolean;
  children: ReactNode;
}) {
  if (sameChannel) {
    return (
      <SameChannelProvider channelId={channelId}>
        {children}
      </SameChannelProvider>
    );
  }
  return (
    <CrossChannelProvider channelId={channelId}>
      {children}
    </CrossChannelProvider>
  );
}

/**
 * Wraps a streaming participant row. Renders a Radix HoverCard whose
 * open state is controlled by the parent provider.
 * Only one trigger can be open at a time — no overlapping popovers.
 */
export function StreamPreviewTrigger({
  participantId,
  children,
}: {
  participantId: string;
  children: ReactNode;
}) {
  const ctx = useContext(StreamPreviewContext);
  if (!ctx) return <>{children}</>;

  const {
    hoveredId,
    sameChannel,
    channelId,
    onEnter,
    onLeave,
    cancelClose,
    getTrackRef,
  } = ctx;
  const isOpen = hoveredId === participantId;

  // Same-channel: get track from primary room
  const trackRef =
    isOpen && sameChannel ? getTrackRef(participantId) : undefined;
  const lastTrackRef = useRef<TrackReference | undefined>(undefined);
  if (trackRef) lastTrackRef.current = trackRef;
  const displayTrackRef =
    trackRef ?? (isOpen && sameChannel ? lastTrackRef.current : undefined);

  // Cross-channel: use secondary preview connection
  const preview = useStreamPreview();

  useEffect(() => {
    if (!sameChannel && isOpen) {
      preview.connect(channelId, participantId);
    } else if (!sameChannel && !isOpen) {
      preview.disconnect();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sameChannel, isOpen, channelId, participantId]);

  const hasContent = sameChannel
    ? displayTrackRef !== undefined
    : preview.status === 'connected' || preview.status === 'connecting';

  return (
    <HoverCard.Root open={isOpen && hasContent}>
      <HoverCard.Trigger asChild>
        <div
          onMouseEnter={() => onEnter(participantId)}
          onMouseLeave={onLeave}
        >
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
          {sameChannel && displayTrackRef ? (
            <SameChannelPreview trackRef={displayTrackRef} />
          ) : !sameChannel ? (
            <CrossChannelPreview
              videoElement={preview.videoElement}
              status={preview.status}
            />
          ) : null}
        </HoverCard.Content>
      </HoverCard.Portal>
    </HoverCard.Root>
  );
}

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
  status: string;
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
