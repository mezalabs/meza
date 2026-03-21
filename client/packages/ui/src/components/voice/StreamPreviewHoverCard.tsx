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

const HOVER_OPEN_DELAY_MS = 400;
const HOVER_SWAP_DELAY_MS = 100;
const HOVER_CLOSE_DELAY_MS = 300;

interface StreamPreviewContextValue {
  hoveredId: string | null;
  onEnter: (participantId: string) => void;
  onLeave: () => void;
  cancelClose: () => void;
  getTrackRef: (participantId: string) => TrackReference | undefined;
}

const StreamPreviewContext = createContext<StreamPreviewContextValue | null>(
  null,
);

/**
 * Wraps a voice channel's participant list. Calls useTracks() once
 * and provides hover state + track refs to child StreamPreviewTrigger components.
 * Only mount this when the user is connected to this channel's LiveKit room.
 */
export function StreamPreviewTrackProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const openTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const closeTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mountedRef = useRef(true);
  const hoveredIdRef = useRef<string | null>(null);

  // Keep ref in sync for use in stable callbacks
  hoveredIdRef.current = hoveredId;

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
  }, [hoveredId, getTrackRef]);

  // Cleanup timers and mounted flag on unmount
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
    // Quick swap when already showing a preview, cold open otherwise
    const delay = hoveredIdRef.current !== null ? HOVER_SWAP_DELAY_MS : HOVER_OPEN_DELAY_MS;
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

  const contextValue = useMemo(
    () => ({ hoveredId, onEnter, onLeave, cancelClose, getTrackRef }),
    [hoveredId, onEnter, onLeave, cancelClose, getTrackRef],
  );

  return (
    <StreamPreviewContext.Provider value={contextValue}>
      {children}
    </StreamPreviewContext.Provider>
  );
}

/**
 * Wraps a streaming participant row. Renders a Radix HoverCard whose
 * open state is controlled by the parent StreamPreviewTrackProvider.
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

  const { hoveredId, onEnter, onLeave, cancelClose, getTrackRef } = ctx;
  const isOpen = hoveredId === participantId;
  const trackRef = isOpen ? getTrackRef(participantId) : undefined;

  // Keep last known track ref so exit animation shows frozen frame instead of empty card
  const lastTrackRef = useRef<TrackReference | undefined>(undefined);
  if (trackRef) lastTrackRef.current = trackRef;
  const displayTrackRef = trackRef ?? (isOpen ? lastTrackRef.current : undefined);

  return (
    <HoverCard.Root open={isOpen && displayTrackRef !== undefined}>
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
          {displayTrackRef && <StreamPreviewContent trackRef={displayTrackRef} />}
        </HoverCard.Content>
      </HoverCard.Portal>
    </HoverCard.Root>
  );
}

function StreamPreviewContent({ trackRef }: { trackRef: TrackReference }) {
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
