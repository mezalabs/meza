import { getStreamPreviewToken } from '@meza/core';
import {
  ConnectionState,
  Room,
  RoomEvent,
  Track,
  VideoQuality,
} from 'livekit-client';
import type { RemoteParticipant, RemoteTrack } from 'livekit-client';
import { useCallback, useEffect, useRef, useState } from 'react';

type PreviewStatus = 'idle' | 'connecting' | 'connected' | 'error';

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
  const mountedRef = useRef(true);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
      const room = roomRef.current;
      if (room && room.state !== ConnectionState.Disconnected) {
        room.disconnect(true);
        room.removeAllListeners();
      }
    };
  }, []);

  const connect = useCallback(
    async (channelId: string, participantId: string) => {
      // Cancel any previous preview
      abortRef.current?.abort();
      const prevRoom = roomRef.current;
      if (prevRoom && prevRoom.state !== ConnectionState.Disconnected) {
        await prevRoom.disconnect(true);
        prevRoom.removeAllListeners();
      }

      const abort = new AbortController();
      abortRef.current = abort;
      roomRef.current = null;

      if (mountedRef.current) {
        setStatus('connecting');
        setVideoElement(null);
      }

      try {
        // Fetch preview token from server
        const res = await getStreamPreviewToken(channelId);
        if (abort.signal.aborted) return;

        // Create secondary room with minimal options
        const room = new Room({
          adaptiveStream: false,
          dynacast: false,
          disconnectOnPageLeave: false,
        });
        roomRef.current = room;

        // Listen for the target screen share track
        room.on(
          RoomEvent.TrackSubscribed,
          (
            track: RemoteTrack,
            _pub: unknown,
            participant: RemoteParticipant,
          ) => {
            if (
              abort.signal.aborted ||
              !mountedRef.current ||
              participant.identity !== participantId ||
              track.source !== Track.Source.ScreenShare
            )
              return;

            const el = track.attach() as HTMLVideoElement;
            setVideoElement(el);
            setStatus('connected');
          },
        );

        // Close preview if the track is unpublished while connected
        room.on(RoomEvent.TrackUnpublished, (_pub: unknown, participant: RemoteParticipant) => {
          if (participant.identity === participantId) {
            if (mountedRef.current) {
              setStatus('idle');
              setVideoElement(null);
            }
          }
        });

        await room.connect(res.livekitUrl, res.livekitToken, {
          autoSubscribe: false,
        });
        if (abort.signal.aborted) {
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
        if (mountedRef.current && !abort.signal.aborted) {
          setStatus('error');
        }
      }
    },
    [],
  );

  const disconnect = useCallback(async () => {
    abortRef.current?.abort();
    const room = roomRef.current;
    if (room && room.state !== ConnectionState.Disconnected) {
      await room.disconnect(true);
      room.removeAllListeners();
    }
    roomRef.current = null;
    if (mountedRef.current) {
      setStatus('idle');
      setVideoElement(null);
    }
  }, []);

  return { status, videoElement, connect, disconnect };
}
