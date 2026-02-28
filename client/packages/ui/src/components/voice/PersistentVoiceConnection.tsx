import {
  soundManager,
  useAudioSettingsStore,
  useNotificationSettingsStore,
  useStreamSettingsStore,
  useVoiceParticipantsStore,
  useVoiceStore,
} from '@meza/core';
import {
  LiveKitRoom,
  RoomAudioRenderer,
  useRoomContext,
} from '@livekit/components-react';
import type {
  LocalTrackPublication,
  Participant,
  RemoteAudioTrack,
  RemoteParticipant,
  RemoteTrack,
  RemoteTrackPublication,
} from 'livekit-client';
import { DataPacket_Kind, RoomEvent, Track } from 'livekit-client';
import { type ReactNode, useEffect, useMemo, useRef } from 'react';
import { viewerQualityToVideoQuality } from '../../utils/streamPresets.ts';

const STREAM_VIEWER_TOPIC = 'meza:stream-viewer';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Applies per-user and global output volumes to a remote participant. */
function applyParticipantVolume(participant: RemoteParticipant) {
  const { outputVolume, perUserVolumes } = useAudioSettingsStore.getState();
  const userId = participant.identity;
  const perUser = perUserVolumes[userId] ?? 1.0;
  try {
    participant.setVolume(outputVolume * perUser);
  } catch {
    // GainNode may not be ready if the track is still attaching
  }
}

/** Applies soundboard volume to Unknown-source audio tracks on a remote participant. */
function applySoundboardVolume(participant: RemoteParticipant) {
  const { soundboardVolume } = useAudioSettingsStore.getState();
  for (const pub of participant.trackPublications.values()) {
    if (pub.source === Track.Source.Unknown && pub.audioTrack) {
      (pub.audioTrack as RemoteAudioTrack).setVolume(soundboardVolume);
    }
  }
}

/** Invisible component that listens to LiveKit room events and syncs them to the voice store. */
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

      // Reapply audio settings after reconnection
      const audioState = useAudioSettingsStore.getState();
      if (audioState.inputDeviceId) {
        room
          .switchActiveDevice('audioinput', audioState.inputDeviceId)
          .catch(() => {});
      }
      if (audioState.outputDeviceId) {
        room
          .switchActiveDevice('audiooutput', audioState.outputDeviceId)
          .catch(() => {});
      }
      // Reapply output volumes
      for (const p of room.remoteParticipants.values()) {
        applyParticipantVolume(p);
        applySoundboardVolume(p);
      }
    };

    // Auto-mute screen share audio so streams start silent for viewers.
    // Apply default viewer quality for screen share video tracks.
    const onTrackSubscribed = (
      track: RemoteTrack,
      publication: RemoteTrackPublication,
      participant: RemoteParticipant,
    ) => {
      if (track.source === Track.Source.ScreenShareAudio) {
        try {
          participant.setVolume(0, Track.Source.ScreenShareAudio);
        } catch {
          // GainNode may not be ready during track attach
        }
      }
      if (
        track.source === Track.Source.Unknown &&
        track.kind === Track.Kind.Audio
      ) {
        applySoundboardVolume(participant);
      }
      if (track.source === Track.Source.ScreenShare) {
        if (publication.simulcasted) {
          const { defaultQuality } = useStreamSettingsStore.getState();
          const quality = viewerQualityToVideoQuality(defaultQuality);
          if (quality !== null) {
            publication.setVideoQuality(quality);
          }
        }
        // Notify the streamer that we started watching
        room.localParticipant
          .publishData(encoder.encode(JSON.stringify({ type: 'join' })), {
            reliable: true,
            topic: STREAM_VIEWER_TOPIC,
            destinationIdentities: [participant.identity],
          })
          .catch(() => {});
      }
    };

    const onTrackUnsubscribed = (
      track: RemoteTrack,
      _publication: RemoteTrackPublication,
      participant: RemoteParticipant,
    ) => {
      if (track.source !== Track.Source.ScreenShare) return;
      // Notify the streamer that we stopped watching
      room.localParticipant
        .publishData(encoder.encode(JSON.stringify({ type: 'leave' })), {
          reliable: true,
          topic: STREAM_VIEWER_TOPIC,
          destinationIdentities: [participant.identity],
        })
        .catch(() => {});
    };

    const onParticipantConnected = (participant: RemoteParticipant) => {
      applyParticipantVolume(participant);
      applySoundboardVolume(participant);
      // Play voice-join sound for non-self participants
      const { soundEnabled, enabledSounds } =
        useNotificationSettingsStore.getState();
      if (soundEnabled && enabledSounds['voice-join']) {
        soundManager.play('voice-join');
      }
      // Optimistic: add participant to sidebar immediately
      const channelId = useVoiceStore.getState().channelId;
      if (channelId) {
        useVoiceParticipantsStore.getState().upsertParticipant(channelId, {
          userId: participant.identity,
          isMuted: !participant.isMicrophoneEnabled,
          isDeafened: false,
          isStreamingVideo: participant.isScreenShareEnabled,
        });
      }
    };

    const onParticipantDisconnected = (_participant: RemoteParticipant) => {
      const { soundEnabled, enabledSounds } =
        useNotificationSettingsStore.getState();
      if (soundEnabled && enabledSounds['voice-leave']) {
        soundManager.play('voice-leave');
      }
      // Optimistic: remove participant from sidebar immediately
      const channelId = useVoiceStore.getState().channelId;
      if (channelId) {
        useVoiceParticipantsStore
          .getState()
          .removeParticipant(channelId, _participant.identity);
      }
    };

    // Sync track mute/unmute to participants store for instant sidebar updates
    const onTrackMuted = (
      _publication: RemoteTrackPublication | LocalTrackPublication,
      participant: Participant,
    ) => {
      const channelId = useVoiceStore.getState().channelId;
      if (!channelId) return;
      if (_publication.source === Track.Source.Microphone) {
        useVoiceParticipantsStore
          .getState()
          .updateParticipant(channelId, participant.identity, {
            isMuted: true,
          });
      }
    };

    const onTrackUnmuted = (
      _publication: RemoteTrackPublication | LocalTrackPublication,
      participant: Participant,
    ) => {
      const channelId = useVoiceStore.getState().channelId;
      if (!channelId) return;
      if (_publication.source === Track.Source.Microphone) {
        useVoiceParticipantsStore
          .getState()
          .updateParticipant(channelId, participant.identity, {
            isMuted: false,
          });
      }
    };

    // Stream sounds + sidebar sync: local publish/unpublish for your own stream
    const onLocalTrackPublished = (publication: LocalTrackPublication) => {
      if (publication.source !== Track.Source.ScreenShare) return;
      const channelId = useVoiceStore.getState().channelId;
      if (channelId) {
        useVoiceParticipantsStore.getState().updateParticipant(channelId, room.localParticipant.identity, { isStreamingVideo: true });
      }
      const { soundEnabled, enabledSounds } =
        useNotificationSettingsStore.getState();
      if (soundEnabled && enabledSounds['stream-start']) {
        soundManager.play('stream-start');
      }
    };

    const onLocalTrackUnpublished = (publication: LocalTrackPublication) => {
      if (publication.source !== Track.Source.ScreenShare) return;
      const channelId = useVoiceStore.getState().channelId;
      if (channelId) {
        useVoiceParticipantsStore.getState().updateParticipant(channelId, room.localParticipant.identity, { isStreamingVideo: false });
      }
      const { soundEnabled, enabledSounds } =
        useNotificationSettingsStore.getState();
      if (soundEnabled && enabledSounds['stream-end']) {
        soundManager.play('stream-end');
      }
    };

    // Stream sounds + sidebar sync: remote participant starts/stops streaming
    const onTrackPublished = (
      publication: RemoteTrackPublication,
      participant: RemoteParticipant,
    ) => {
      if (publication.source !== Track.Source.ScreenShare) return;
      const channelId = useVoiceStore.getState().channelId;
      if (channelId) {
        useVoiceParticipantsStore.getState().updateParticipant(channelId, participant.identity, { isStreamingVideo: true });
      }
      const { soundEnabled, enabledSounds } =
        useNotificationSettingsStore.getState();
      if (soundEnabled && enabledSounds['stream-start']) {
        soundManager.play('stream-start');
      }
    };

    const onTrackUnpublished = (
      publication: RemoteTrackPublication,
      participant: RemoteParticipant,
    ) => {
      if (publication.source !== Track.Source.ScreenShare) return;
      const channelId = useVoiceStore.getState().channelId;
      if (channelId) {
        useVoiceParticipantsStore.getState().updateParticipant(channelId, participant.identity, { isStreamingVideo: false });
      }
      const { soundEnabled, enabledSounds } =
        useNotificationSettingsStore.getState();
      if (soundEnabled && enabledSounds['stream-end']) {
        soundManager.play('stream-end');
      }
    };

    // Stream viewer sounds: publisher receives join/leave data messages
    const onDataReceived = (
      payload: Uint8Array,
      _participant?: RemoteParticipant,
      _kind?: DataPacket_Kind,
      topic?: string,
    ) => {
      if (topic !== STREAM_VIEWER_TOPIC) return;
      try {
        const msg = JSON.parse(decoder.decode(payload));
        const { soundEnabled, enabledSounds } =
          useNotificationSettingsStore.getState();
        if (!soundEnabled) return;
        if (msg.type === 'join' && enabledSounds['stream-join']) {
          soundManager.play('stream-join');
        } else if (msg.type === 'leave' && enabledSounds['stream-leave']) {
          soundManager.play('stream-leave');
        }
      } catch {
        // Ignore malformed data
      }
    };

    room.on(RoomEvent.Reconnecting, onReconnecting);
    room.on(RoomEvent.Reconnected, onReconnected);
    room.on(RoomEvent.TrackSubscribed, onTrackSubscribed);
    room.on(RoomEvent.TrackUnsubscribed, onTrackUnsubscribed);
    room.on(RoomEvent.ParticipantConnected, onParticipantConnected);
    room.on(RoomEvent.ParticipantDisconnected, onParticipantDisconnected);
    room.on(RoomEvent.LocalTrackPublished, onLocalTrackPublished);
    room.on(RoomEvent.LocalTrackUnpublished, onLocalTrackUnpublished);
    room.on(RoomEvent.TrackPublished, onTrackPublished);
    room.on(RoomEvent.TrackUnpublished, onTrackUnpublished);
    room.on(RoomEvent.DataReceived, onDataReceived);
    room.on(RoomEvent.TrackMuted, onTrackMuted);
    room.on(RoomEvent.TrackUnmuted, onTrackUnmuted);

    // Seed remote participants from current room state on mount.
    // Local user is already handled optimistically by useVoiceConnection.
    const channelId = useVoiceStore.getState().channelId;
    if (channelId) {
      for (const p of room.remoteParticipants.values()) {
        if (!p.identity) continue;
        useVoiceParticipantsStore.getState().upsertParticipant(channelId, {
          userId: p.identity,
          isMuted: !p.isMicrophoneEnabled,
          isDeafened: false,
          isStreamingVideo: p.isScreenShareEnabled,
        });
      }
    }

    return () => {
      room.off(RoomEvent.Reconnecting, onReconnecting);
      room.off(RoomEvent.Reconnected, onReconnected);
      room.off(RoomEvent.TrackSubscribed, onTrackSubscribed);
      room.off(RoomEvent.TrackUnsubscribed, onTrackUnsubscribed);
      room.off(RoomEvent.ParticipantConnected, onParticipantConnected);
      room.off(RoomEvent.ParticipantDisconnected, onParticipantDisconnected);
      room.off(RoomEvent.LocalTrackPublished, onLocalTrackPublished);
      room.off(RoomEvent.LocalTrackUnpublished, onLocalTrackUnpublished);
      room.off(RoomEvent.TrackPublished, onTrackPublished);
      room.off(RoomEvent.TrackUnpublished, onTrackUnpublished);
      room.off(RoomEvent.DataReceived, onDataReceived);
      room.off(RoomEvent.TrackMuted, onTrackMuted);
      room.off(RoomEvent.TrackUnmuted, onTrackUnmuted);
    };
  }, [room]);

  return null;
}

/** Syncs audio settings store changes to the LiveKit room. */
function AudioSettingsSync() {
  const room = useRoomContext();

  const inputDeviceId = useAudioSettingsStore((s) => s.inputDeviceId);
  const outputDeviceId = useAudioSettingsStore((s) => s.outputDeviceId);
  const noiseSuppression = useAudioSettingsStore((s) => s.noiseSuppression);
  const echoCancellation = useAudioSettingsStore((s) => s.echoCancellation);
  const autoGainControl = useAudioSettingsStore((s) => s.autoGainControl);
  const outputVolume = useAudioSettingsStore((s) => s.outputVolume);
  const perUserVolumes = useAudioSettingsStore((s) => s.perUserVolumes);
  const soundboardVolume = useAudioSettingsStore((s) => s.soundboardVolume);

  // Track first render to avoid switching devices on mount
  const isFirstRender = useRef(true);

  // Live input device switching
  useEffect(() => {
    if (isFirstRender.current) return;
    if (inputDeviceId) {
      room.switchActiveDevice('audioinput', inputDeviceId).catch(() => {});
    }
  }, [room, inputDeviceId]);

  // Live output device switching
  useEffect(() => {
    if (isFirstRender.current) return;
    if (outputDeviceId) {
      room.switchActiveDevice('audiooutput', outputDeviceId).catch(() => {});
    }
  }, [room, outputDeviceId]);

  // Live audio processing changes — restart mic track with new constraints
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    if (room.localParticipant.isMicrophoneEnabled) {
      room.localParticipant
        .setMicrophoneEnabled(true, {
          noiseSuppression,
          echoCancellation,
          autoGainControl,
        })
        .catch(() => {});
    }
  }, [room, noiseSuppression, echoCancellation, autoGainControl]);

  // Apply output volume to all remote participants
  useEffect(() => {
    for (const p of room.remoteParticipants.values()) {
      applyParticipantVolume(p);
    }
  }, [room, outputVolume, perUserVolumes]);

  // Apply soundboard volume to Unknown-source tracks
  useEffect(() => {
    for (const p of room.remoteParticipants.values()) {
      for (const pub of p.trackPublications.values()) {
        if (pub.source === Track.Source.Unknown && pub.audioTrack) {
          (pub.audioTrack as RemoteAudioTrack).setVolume(soundboardVolume);
        }
      }
    }
  }, [room, soundboardVolume]);

  return null;
}

/** Applies contentHint changes to the active screen share track mid-stream. */
function StreamSettingsSync() {
  const room = useRoomContext();
  const contentHint = useStreamSettingsStore((s) => s.contentHint);

  useEffect(() => {
    const screenSharePub = room.localParticipant.getTrackPublication(
      Track.Source.ScreenShare,
    );
    const mediaTrack = screenSharePub?.track?.mediaStreamTrack;
    if (mediaTrack) {
      mediaTrack.contentHint = contentHint;
    }
  }, [room, contentHint]);

  return null;
}

/**
 * Wraps shell content so the LiveKit Room context is available to all descendants
 * (including VoicePanel). The WebRTC connection is controlled by the `connect` prop —
 * when idle, LiveKitRoom provides context but doesn't connect.
 */
export function PersistentVoiceConnection({
  children,
}: {
  children: ReactNode;
}) {
  const status = useVoiceStore((s) => s.status);
  const url = useVoiceStore((s) => s.livekitUrl);
  const token = useVoiceStore((s) => s.livekitToken);
  const isActive = status !== 'idle' && !!url && !!token;

  const inputDeviceId = useAudioSettingsStore((s) => s.inputDeviceId);
  const noiseSuppression = useAudioSettingsStore((s) => s.noiseSuppression);
  const echoCancellation = useAudioSettingsStore((s) => s.echoCancellation);
  const autoGainControl = useAudioSettingsStore((s) => s.autoGainControl);

  const audioConstraints = useMemo(
    () => ({
      deviceId: inputDeviceId ? { ideal: inputDeviceId } : undefined,
      noiseSuppression,
      echoCancellation,
      autoGainControl,
    }),
    [inputDeviceId, noiseSuppression, echoCancellation, autoGainControl],
  );

  return (
    <LiveKitRoom
      serverUrl={url ?? undefined}
      token={token ?? undefined}
      audio={audioConstraints}
      video={false}
      connect={isActive}
      options={{ webAudioMix: true }}
      onDisconnected={() => {
        // Don't reset state if we're mid-switch (connecting to a new channel).
        // The old room's disconnect event would otherwise nuke the new connection.
        if (useVoiceStore.getState().status !== 'connecting') {
          useVoiceStore.getState().disconnect();
        }
      }}
      style={{ display: 'contents' }}
    >
      {children}
      {isActive && (
        <>
          <RoomAudioRenderer />
          <VoiceEventHandler />
          <AudioSettingsSync />
          <StreamSettingsSync />
        </>
      )}
    </LiveKitRoom>
  );
}
