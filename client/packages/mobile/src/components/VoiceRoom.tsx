/**
 * VoiceRoom — LiveKit Room wrapper for React Native.
 *
 * Manages AudioSession lifecycle and provides LiveKitRoom context
 * for voice channel calls. Syncs room events to voice stores.
 */

import {
  AudioSession,
  LiveKitRoom,
  useParticipants,
  useRoomContext,
} from '@livekit/react-native';
import {
  useAuthStore,
  useUsersStore,
  useVoiceParticipantsStore,
  useVoiceStore,
  getProfile,
} from '@meza/core';
import type { Participant, RemoteParticipant } from 'livekit-client';
import { RoomEvent, Track } from 'livekit-client';
import { useEffect, useRef, type ReactNode } from 'react';

/** Syncs LiveKit room events → voice stores. */
function VoiceEventHandler() {
  const room = useRoomContext();

  useEffect(() => {
    const onReconnecting = () => {
      useVoiceStore.getState().setReconnecting();
    };

    const onReconnected = () => {
      const voiceState = useVoiceStore.getState();
      if (voiceState.livekitUrl && voiceState.livekitToken) {
        voiceState.setConnected(
          voiceState.livekitUrl,
          voiceState.livekitToken,
          voiceState.canScreenShare,
        );
      }
    };

    const onParticipantConnected = (participant: RemoteParticipant) => {
      const channelId = useVoiceStore.getState().channelId;
      if (channelId) {
        useVoiceParticipantsStore.getState().upsertParticipant(channelId, {
          userId: participant.identity,
          isMuted: !participant.isMicrophoneEnabled,
          isDeafened: false,
          isStreamingVideo: false,
        });
      }
    };

    const onParticipantDisconnected = (participant: RemoteParticipant) => {
      const channelId = useVoiceStore.getState().channelId;
      if (channelId) {
        useVoiceParticipantsStore
          .getState()
          .removeParticipant(channelId, participant.identity);
      }
    };

    const onTrackMuted = (
      _pub: unknown,
      participant: Participant,
    ) => {
      const channelId = useVoiceStore.getState().channelId;
      if (!channelId) return;
      useVoiceParticipantsStore
        .getState()
        .updateParticipant(channelId, participant.identity, {
          isMuted: true,
        });
    };

    const onTrackUnmuted = (
      _pub: unknown,
      participant: Participant,
    ) => {
      const channelId = useVoiceStore.getState().channelId;
      if (!channelId) return;
      useVoiceParticipantsStore
        .getState()
        .updateParticipant(channelId, participant.identity, {
          isMuted: false,
        });
    };

    room.on(RoomEvent.Reconnecting, onReconnecting);
    room.on(RoomEvent.Reconnected, onReconnected);
    room.on(RoomEvent.ParticipantConnected, onParticipantConnected);
    room.on(RoomEvent.ParticipantDisconnected, onParticipantDisconnected);
    room.on(RoomEvent.TrackMuted, onTrackMuted);
    room.on(RoomEvent.TrackUnmuted, onTrackUnmuted);

    // Seed existing remote participants on mount
    const channelId = useVoiceStore.getState().channelId;
    if (channelId) {
      for (const p of room.remoteParticipants.values()) {
        if (!p.identity) continue;
        useVoiceParticipantsStore.getState().upsertParticipant(channelId, {
          userId: p.identity,
          isMuted: !p.isMicrophoneEnabled,
          isDeafened: false,
          isStreamingVideo: false,
        });
      }
    }

    return () => {
      room.off(RoomEvent.Reconnecting, onReconnecting);
      room.off(RoomEvent.Reconnected, onReconnected);
      room.off(RoomEvent.ParticipantConnected, onParticipantConnected);
      room.off(RoomEvent.ParticipantDisconnected, onParticipantDisconnected);
      room.off(RoomEvent.TrackMuted, onTrackMuted);
      room.off(RoomEvent.TrackUnmuted, onTrackUnmuted);
    };
  }, [room]);

  return null;
}

/** Fetches profiles for participants whose profiles we don't have. */
function ProfileFetcher() {
  const participants = useParticipants();
  const inflightProfiles = useRef(new Set<string>());

  useEffect(() => {
    const profiles = useUsersStore.getState().profiles;
    for (const p of participants) {
      const userId = p.identity;
      if (userId && !profiles[userId] && !inflightProfiles.current.has(userId)) {
        inflightProfiles.current.add(userId);
        getProfile(userId)
          .catch(() => {})
          .finally(() => inflightProfiles.current.delete(userId));
      }
    }
  }, [participants]);

  return null;
}

/**
 * Wraps children in LiveKitRoom context when a voice connection is active.
 * Manages native AudioSession start/stop.
 */
export function VoiceRoomProvider({ children }: { children: ReactNode }) {
  const status = useVoiceStore((s) => s.status);
  const url = useVoiceStore((s) => s.livekitUrl);
  const token = useVoiceStore((s) => s.livekitToken);
  const isActive = status !== 'idle' && !!url && !!token;

  // Start/stop native audio session when voice connection activates
  useEffect(() => {
    if (isActive) {
      AudioSession.startAudioSession();
    }
    return () => {
      if (isActive) {
        AudioSession.stopAudioSession();
      }
    };
  }, [isActive]);

  return (
    <LiveKitRoom
      serverUrl={url ?? undefined}
      token={token ?? undefined}
      connect={isActive}
      audio={true}
      video={false}
      onDisconnected={() => {
        if (useVoiceStore.getState().status !== 'connecting') {
          useVoiceStore.getState().disconnect();
        }
      }}
    >
      {children}
      {isActive && (
        <>
          <VoiceEventHandler />
          <ProfileFetcher />
        </>
      )}
    </LiveKitRoom>
  );
}
