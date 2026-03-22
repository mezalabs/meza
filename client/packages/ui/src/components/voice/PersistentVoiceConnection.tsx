import {
  LiveKitRoom,
  RoomAudioRenderer,
  useRoomContext,
  useTracks,
} from '@livekit/components-react';
import {
  soundManager,
  useAudioSettingsStore,
  useGatewayStore,
  useNotificationSettingsStore,
  useStreamSettingsStore,
  useToastStore,
  useVoiceParticipantsStore,
  useVoiceStore,
} from '@meza/core';
import type {
  LocalAudioTrack,
  LocalTrackPublication,
  Participant,
  RemoteAudioTrack,
  RemoteParticipant,
  RemoteTrack,
  RemoteTrackPublication,
  TrackPublication,
} from 'livekit-client';
import {
  type DataPacket_Kind,
  ExternalE2EEKeyProvider,
  RoomEvent,
  Track,
} from 'livekit-client';
import { type ReactNode, useCallback, useEffect, useMemo, useRef } from 'react';
import {
  preloadRnnoiseWorklet,
  RnnoiseTrackProcessor,
} from '../../audio/rnnoise-processor.ts';
import { viewerQualityToVideoQuality } from '../../utils/streamPresets.ts';
import { setVoiceRoom } from '../../utils/voiceControls.ts';

const STREAM_VIEWER_TOPIC = 'meza:stream-viewer';
const decoder = new TextDecoder();

// --- E2EE setup ---

/** Module-level key provider — survives channel switches, cleared on logout. */
export const e2eeKeyProvider = new ExternalE2EEKeyProvider({
  ratchetWindowSize: 0, // disabled — no ratchet coordination protocol
  failureTolerance: 10,
});

function createE2EEWorker() {
  return new Worker(new URL('livekit-client/e2ee-worker', import.meta.url), {
    type: 'module',
  });
}

/** Clear E2EE key material. Call from session teardown alongside clearChannelKeyCache(). */
export function resetE2EEKeyProvider() {
  e2eeKeyProvider.setKey(new ArrayBuffer(0));
}

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

  // Expose the room instance for imperative access (keybind-driven mute/deafen).
  useEffect(() => {
    setVoiceRoom(room);
    return () => setVoiceRoom(null);
  }, [room]);

  // Enable E2EE on the room — setupE2EE() in the Room constructor only
  // configures the infrastructure (worker, key provider), but the local
  // participant's encryptionType stays NONE until setE2EEEnabled(true) is
  // called, which tells the worker to actually encrypt frames.
  useEffect(() => {
    room.setE2EEEnabled(true).catch(() => {});
  }, [room]);

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
      }
    };

    const onParticipantConnected = (participant: RemoteParticipant) => {
      // Ignore hidden preview participants — they should be invisible.
      if (participant.identity.startsWith('preview:')) return;

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
          isEncrypted: false,
        });
      }
    };

    const onParticipantDisconnected = (_participant: RemoteParticipant) => {
      // Ignore hidden preview participants — they should be invisible.
      if (_participant.identity.startsWith('preview:')) return;

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
      _publication: TrackPublication,
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
      _publication: TrackPublication,
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
        useVoiceParticipantsStore
          .getState()
          .updateParticipant(channelId, room.localParticipant.identity, {
            isStreamingVideo: true,
          });
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
        useVoiceParticipantsStore
          .getState()
          .updateParticipant(channelId, room.localParticipant.identity, {
            isStreamingVideo: false,
          });
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
        useVoiceParticipantsStore
          .getState()
          .updateParticipant(channelId, participant.identity, {
            isStreamingVideo: true,
          });
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
        useVoiceParticipantsStore
          .getState()
          .updateParticipant(channelId, participant.identity, {
            isStreamingVideo: false,
          });
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
    room.on(RoomEvent.ParticipantConnected, onParticipantConnected);
    room.on(RoomEvent.ParticipantDisconnected, onParticipantDisconnected);
    room.on(RoomEvent.LocalTrackPublished, onLocalTrackPublished);
    room.on(RoomEvent.LocalTrackUnpublished, onLocalTrackUnpublished);
    room.on(RoomEvent.TrackPublished, onTrackPublished);
    room.on(RoomEvent.TrackUnpublished, onTrackUnpublished);
    room.on(RoomEvent.DataReceived, onDataReceived);
    room.on(RoomEvent.TrackMuted, onTrackMuted);
    room.on(RoomEvent.TrackUnmuted, onTrackUnmuted);

    // --- E2EE event listeners ---

    let e2eeErrorCount = 0;

    const onEncryptionStatusChanged = (
      enabled: boolean,
      participant?: Participant,
    ) => {
      const channelId = useVoiceStore.getState().channelId;
      if (!participant || !channelId) return;

      // Check previous status before updating — only warn when a
      // previously-encrypted participant loses encryption, not during
      // the initial handshake (where status starts as false).
      if (!enabled) {
        const wasEncrypted = useVoiceParticipantsStore
          .getState()
          .byChannel[channelId]?.some(
            (p) => p.userId === participant.identity && p.isEncrypted,
          );
        if (wasEncrypted) {
          useToastStore
            .getState()
            .addToast(
              `${participant.identity} is no longer using encryption`,
              'warning',
            );
        }
      }

      // Update the participant's encryption status in the store
      useVoiceParticipantsStore
        .getState()
        .updateParticipant(channelId, participant.identity, {
          isEncrypted: enabled,
        });
    };

    const onEncryptionError = (error: Error) => {
      e2eeErrorCount++;
      if (e2eeErrorCount <= 10) {
        console.error('[E2EE] Encryption error:', error);
      }
      if (e2eeErrorCount === 10) {
        useToastStore
          .getState()
          .addToast(
            'Encryption issue \u2014 please rejoin the voice channel',
            'error',
          );
      }
    };

    // Sync encryption status from LiveKit participant objects into the store.
    // Called at mount and on Connected to catch status the event may have
    // fired before we subscribed (e.g. React Strict Mode double-mount).
    const syncEncryptionStatus = () => {
      const channelId = useVoiceStore.getState().channelId;
      if (!channelId) return;
      // Local participant
      if (room.localParticipant.identity) {
        useVoiceParticipantsStore
          .getState()
          .updateParticipant(channelId, room.localParticipant.identity, {
            isEncrypted: room.localParticipant.isEncrypted,
          });
      }
      // Remote participants
      for (const p of room.remoteParticipants.values()) {
        if (!p.identity) continue;
        useVoiceParticipantsStore
          .getState()
          .updateParticipant(channelId, p.identity, {
            isEncrypted: p.isEncrypted,
          });
      }
    };

    // E2EE status isn't available immediately on Connected — the worker
    // needs time to process the first frames.  Poll briefly after connect
    // so we catch the status even if the event fired before we subscribed.
    let encryptionPollTimer: ReturnType<typeof setTimeout> | undefined;

    const onConnected = () => {
      encryptionPollTimer = setTimeout(syncEncryptionStatus, 2000);
    };

    room.on(
      RoomEvent.ParticipantEncryptionStatusChanged,
      onEncryptionStatusChanged,
    );
    room.on(RoomEvent.EncryptionError, onEncryptionError);
    room.on(RoomEvent.Connected, onConnected);

    // Seed remote participants from current room state on mount.
    // Local user is already handled optimistically by useVoiceConnection.
    const channelId = useVoiceStore.getState().channelId;
    if (channelId) {
      for (const p of room.remoteParticipants.values()) {
        if (!p.identity || p.identity.startsWith('preview:')) continue;
        useVoiceParticipantsStore.getState().upsertParticipant(channelId, {
          userId: p.identity,
          isMuted: !p.isMicrophoneEnabled,
          isDeafened: false,
          isStreamingVideo: p.isScreenShareEnabled,
          isEncrypted: p.isEncrypted,
        });
      }
      // For already-connected rooms, poll after a delay to let E2EE settle
      encryptionPollTimer = setTimeout(syncEncryptionStatus, 2000);
    }

    return () => {
      room.off(RoomEvent.Reconnecting, onReconnecting);
      room.off(RoomEvent.Reconnected, onReconnected);
      room.off(RoomEvent.TrackSubscribed, onTrackSubscribed);
      room.off(RoomEvent.ParticipantConnected, onParticipantConnected);
      room.off(RoomEvent.ParticipantDisconnected, onParticipantDisconnected);
      room.off(RoomEvent.LocalTrackPublished, onLocalTrackPublished);
      room.off(RoomEvent.LocalTrackUnpublished, onLocalTrackUnpublished);
      room.off(RoomEvent.TrackPublished, onTrackPublished);
      room.off(RoomEvent.TrackUnpublished, onTrackUnpublished);
      room.off(RoomEvent.DataReceived, onDataReceived);
      room.off(RoomEvent.TrackMuted, onTrackMuted);
      room.off(RoomEvent.TrackUnmuted, onTrackUnmuted);
      room.off(
        RoomEvent.ParticipantEncryptionStatusChanged,
        onEncryptionStatusChanged,
      );
      room.off(RoomEvent.EncryptionError, onEncryptionError);
      room.off(RoomEvent.Connected, onConnected);
      clearTimeout(encryptionPollTimer);
    };
  }, [room]);

  return null;
}

/** Syncs audio settings store changes to the LiveKit room. */
function AudioSettingsSync() {
  const room = useRoomContext();

  const inputDeviceId = useAudioSettingsStore((s) => s.inputDeviceId);
  const outputDeviceId = useAudioSettingsStore((s) => s.outputDeviceId);
  const noiseCancellationMode = useAudioSettingsStore(
    (s) => s.noiseCancellationMode,
  );
  const gigaThreshold = useAudioSettingsStore((s) => s.gigaThreshold);
  const echoCancellation = useAudioSettingsStore((s) => s.echoCancellation);
  const autoGainControl = useAudioSettingsStore((s) => s.autoGainControl);
  const _outputVolume = useAudioSettingsStore((s) => s.outputVolume);
  const _perUserVolumes = useAudioSettingsStore((s) => s.perUserVolumes);
  const soundboardVolume = useAudioSettingsStore((s) => s.soundboardVolume);

  // Derive browser-native noiseSuppression from the cancellation mode
  const noiseSuppression = noiseCancellationMode === 'standard';

  // Track first render to avoid switching devices on mount
  const isFirstRender = useRef(true);

  // Track the current processor instance for cleanup
  const processorRef = useRef<RnnoiseTrackProcessor | null>(null);
  // Debounce timer for processor pipeline changes
  const processorTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Get local mic track via useTracks for stable references (avoids infinite re-renders)
  const tracks = useTracks([Track.Source.Microphone], {
    onlySubscribed: false,
  });
  const localMicTrack = tracks.find((t) => t.participant.isLocal)?.publication
    ?.track as LocalAudioTrack | undefined;

  /** Attach or detach the RNNoise processor based on the current mode. */
  const syncProcessor = useCallback(
    async (track: LocalAudioTrack | undefined, mode: string) => {
      if (mode === 'giga' && track) {
        // Already attached? Skip.
        if (
          processorRef.current &&
          track.getProcessor() === processorRef.current
        ) {
          return;
        }
        try {
          const processor = new RnnoiseTrackProcessor();
          await track.setProcessor(processor);
          processor.setThreshold(
            useAudioSettingsStore.getState().gigaThreshold / 100,
          );
          processorRef.current = processor;
        } catch (err) {
          // WASM/worklet load failed — fall back to Standard
          console.error('[GIGA] RNNoise processor failed to load:', err);
          useAudioSettingsStore.getState().setNoiseCancellationMode('standard');
          useToastStore
            .getState()
            .addToast(
              'GIGA noise cancellation unavailable \u2014 using Standard mode',
              'warning',
            );
        }
      } else {
        // Detach processor if active
        if (processorRef.current) {
          try {
            await localMicTrack?.stopProcessor();
          } catch {
            // Track may already be stopped
          }
          processorRef.current = null;
        }
      }
    },
    [localMicTrack],
  );

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

  // RNNoise processor lifecycle: attach/detach based on mode and track presence
  useEffect(() => {
    // Debounce to handle rapid toggling (300ms)
    clearTimeout(processorTimerRef.current);
    processorTimerRef.current = setTimeout(() => {
      syncProcessor(localMicTrack, noiseCancellationMode);
    }, 300);

    return () => clearTimeout(processorTimerRef.current);
  }, [localMicTrack, noiseCancellationMode, syncProcessor]);

  // Sync GIGA threshold to the active processor
  useEffect(() => {
    processorRef.current?.setThreshold(gigaThreshold / 100);
  }, [gigaThreshold]);

  // Cleanup processor on unmount
  useEffect(() => {
    return () => {
      processorRef.current?.destroy();
      processorRef.current = null;
    };
  }, []);

  // Apply output volume to all remote participants
  useEffect(() => {
    for (const p of room.remoteParticipants.values()) {
      applyParticipantVolume(p);
    }
  }, [room]);

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
  const noiseCancellationMode = useAudioSettingsStore(
    (s) => s.noiseCancellationMode,
  );

  // Preload the 1.9MB RNNoise worklet when the gateway connects and GIGA
  // mode is enabled, so the WASM module is already cached when the user
  // joins a voice channel.
  const gatewayStatus = useGatewayStore((s) => s.status);
  useEffect(() => {
    if (gatewayStatus === 'connected' && noiseCancellationMode === 'giga') {
      preloadRnnoiseWorklet();
    }
  }, [gatewayStatus, noiseCancellationMode]);

  const echoCancellation = useAudioSettingsStore((s) => s.echoCancellation);
  const autoGainControl = useAudioSettingsStore((s) => s.autoGainControl);

  // Derive browser-native noiseSuppression from the cancellation mode:
  // 'standard' uses browser built-in, 'giga' and 'off' disable it
  const noiseSuppression = noiseCancellationMode === 'standard';

  const audioConstraints = useMemo(
    () => ({
      deviceId: inputDeviceId ? { ideal: inputDeviceId } : undefined,
      noiseSuppression,
      echoCancellation,
      autoGainControl,
    }),
    [inputDeviceId, noiseSuppression, echoCancellation, autoGainControl],
  );

  // E2EE worker — created once. LiveKit's Room manages the worker lifecycle
  // through its E2EEManager; we must NOT terminate it manually because React
  // Strict Mode re-runs effects with the same memoized (now-dead) worker.
  const e2eeWorker = useMemo(() => createE2EEWorker(), []);

  const roomOptions = useMemo(
    () => ({
      webAudioMix: true,
      e2ee: {
        keyProvider: e2eeKeyProvider,
        worker: e2eeWorker,
      },
    }),
    [e2eeWorker],
  );

  return (
    <LiveKitRoom
      serverUrl={url ?? undefined}
      token={token ?? undefined}
      audio={audioConstraints}
      video={false}
      connect={isActive}
      options={roomOptions}
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
