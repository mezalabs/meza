import { getStreamPreviewToken } from '@meza/core';
import {
  ConnectionState,
  Room,
  RoomEvent,
  Track,
  VideoQuality,
} from 'livekit-client';
import type {
  RemoteParticipant,
  RemoteTrack,
  RemoteTrackPublication,
} from 'livekit-client';
import { useCallback, useEffect, useRef, useState } from 'react';

export type PreviewStatus = 'idle' | 'connecting' | 'connected' | 'error';

/**
 * Manages a secondary LiveKit room connection for cross-channel stream preview.
 * Connects as a hidden, subscribe-only participant to preview a specific
 * participant's screen share without joining the channel.
 */
export function useStreamPreview() {
  const [status, setStatus] = useState<PreviewStatus>('idle');
  const [videoElement, setVideoElement] = useState<HTMLVideoElement | null>(
    null,
  );
  const roomRef = useRef<Room | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      const room = roomRef.current;
      if (room) {
        detachAllTracks(room);
        room.removeAllListeners();
        if (room.state !== ConnectionState.Disconnected) {
          room.disconnect(true);
        }
      }
    };
  }, []);

  const connect = useCallback(
    async (channelId: string, participantId: string) => {
      // Cancel any previous preview
      abortRef.current?.abort();
      const prevRoom = roomRef.current;
      // Null out ref before awaiting to prevent concurrent disconnect calls
      roomRef.current = null;
      if (prevRoom) {
        detachAllTracks(prevRoom);
        prevRoom.removeAllListeners();
        if (prevRoom.state !== ConnectionState.Disconnected) {
          await prevRoom.disconnect(true);
        }
      }

      const abort = new AbortController();
      abortRef.current = abort;

      setStatus('connecting');
      setVideoElement(null);

      try {
        const res = await getStreamPreviewToken(channelId);
        if (abort.signal.aborted) return;

        const room = new Room({
          adaptiveStream: false,
          dynacast: false,
          disconnectOnPageLeave: false,
        });
        roomRef.current = room;

        room.on(
          RoomEvent.TrackSubscribed,
          (
            track: RemoteTrack,
            _pub: RemoteTrackPublication,
            participant: RemoteParticipant,
          ) => {
            if (
              abort.signal.aborted ||
              participant.identity !== participantId ||
              track.source !== Track.Source.ScreenShare
            )
              return;

            const el = track.attach() as HTMLVideoElement;
            setVideoElement(el);
            setStatus('connected');
          },
        );

        room.on(
          RoomEvent.TrackUnpublished,
          (_pub: RemoteTrackPublication, participant: RemoteParticipant) => {
            if (abort.signal.aborted) return;
            if (participant.identity === participantId) {
              setStatus('idle');
              setVideoElement(null);
            }
          },
        );

        await room.connect(res.livekitUrl, res.livekitToken, {
          autoSubscribe: false,
        });
        if (abort.signal.aborted) {
          room.removeAllListeners();
          await room.disconnect(true);
          return;
        }

        // Subscribe to existing screen share if already published
        const participant = room.remoteParticipants.get(participantId);
        const pub = participant?.getTrackPublication(
          Track.Source.ScreenShare,
        );
        if (pub) {
          pub.setSubscribed(true);
          if (pub.simulcasted) pub.setVideoQuality(VideoQuality.LOW);
        }
      } catch {
        if (!abort.signal.aborted) {
          setStatus('error');
        }
      }
    },
    [],
  );

  const disconnect = useCallback(async () => {
    abortRef.current?.abort();
    const room = roomRef.current;
    roomRef.current = null;
    if (room) {
      detachAllTracks(room);
      room.removeAllListeners();
      if (room.state !== ConnectionState.Disconnected) {
        await room.disconnect(true);
      }
    }
    setStatus('idle');
    setVideoElement(null);
  }, []);

  return { status, videoElement, connect, disconnect };
}

/** Detach all remote tracks to prevent leaked video elements. */
function detachAllTracks(room: Room) {
  for (const p of room.remoteParticipants.values()) {
    for (const pub of p.trackPublications.values()) {
      pub.track?.detach();
    }
  }
}
