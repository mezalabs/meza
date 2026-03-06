import type { TrackReference } from '@livekit/components-react';
import {
  useIsSpeaking,
  useLocalParticipant,
  useParticipants,
  useRemoteParticipants,
  useTracks,
  VideoTrack,
} from '@livekit/components-react';
import {
  getProfile,
  paneCount,
  soundManager,
  useAudioSettingsStore,
  useChannelStore,
  useNotificationSettingsStore,
  useStreamSettingsStore,
  useUsersStore,
  useVoiceParticipantsStore,
  useVoiceStore,
} from '@meza/core';
import {
  EarIcon,
  EarSlashIcon,
  MicrophoneIcon,
  MicrophoneSlashIcon,
  MonitorArrowUpIcon,
  MonitorIcon,
  PhoneSlashIcon,
  SpeakerHighIcon,
  SpeakerSlashIcon,
  VideoCameraIcon,
} from '@phosphor-icons/react';
import type { Participant } from 'livekit-client';
import { RoomEvent, Track } from 'livekit-client';
import { useEffect, useRef, useState } from 'react';
import {
  resolveDisplayName,
  useDisplayName,
} from '../../hooks/useDisplayName.ts';
import { useLocalSpeaking } from '../../hooks/useLocalSpeaking.ts';
import { useMobile } from '../../hooks/useMobile.ts';
import { useVoiceConnection } from '../../hooks/useVoiceConnection.ts';
import { MAX_PANES, useTilingStore } from '../../stores/tiling.ts';
import {
  buildCaptureOptions,
  buildPublishOptions,
} from '../../utils/streamPresets.ts';
import { toggleDeafen, toggleMute } from '../../utils/voiceControls.ts';
import { ProfilePopoverCard } from '../profile/ProfilePopoverCard.tsx';
import { Avatar } from '../shared/Avatar.tsx';
import { PresenceDot } from '../shared/PresenceDot.tsx';
import { SoundboardPanel } from './SoundboardPanel.tsx';

/* ——— Main component ——— */

interface VoicePanelProps {
  channelId: string;
}

export function VoicePanel({ channelId }: VoicePanelProps) {
  const voiceStatus = useVoiceStore((s) => s.status);
  const voiceChannelId = useVoiceStore((s) => s.channelId);
  const error = useVoiceStore((s) => s.error);
  const isConnectedHere =
    voiceStatus === 'connected' && voiceChannelId === channelId;
  const isConnectedElsewhere =
    voiceStatus === 'connected' && voiceChannelId !== channelId;
  const isConnecting = voiceStatus === 'connecting';

  // Resolve channel name and serverId from store
  const channelsByServer = useChannelStore((s) => s.byServer);
  const { channelName, serverId } = (() => {
    for (const [sId, channels] of Object.entries(channelsByServer)) {
      const match = channels.find((c) => c.id === channelId);
      if (match) return { channelName: match.name, serverId: sId };
    }
    return { channelName: channelId, serverId: undefined };
  })();

  return (
    <div className="flex h-full flex-col bg-bg-base">
      {/* Body */}
      <div className="flex flex-1 flex-col items-center justify-center gap-4 p-4">
        {(isConnectedHere || isConnecting) && (
          <span
            className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
              isConnectedHere
                ? 'bg-success/20 text-success'
                : 'bg-warning/20 text-warning'
            }`}
          >
            {isConnectedHere ? 'Connected' : 'Connecting...'}
          </span>
        )}
        {error && (
          <div className="rounded-md bg-error/10 px-3 py-2 text-sm text-error">
            {error}
          </div>
        )}

        {isConnectedHere ? (
          <ConnectedView channelId={channelId} serverId={serverId} />
        ) : (
          <DisconnectedView
            channelId={channelId}
            channelName={channelName}
            isConnecting={isConnecting}
            isConnectedElsewhere={isConnectedElsewhere}
          />
        )}
      </div>
    </div>
  );
}

function DisconnectedView({
  channelId,
  channelName,
  isConnecting,
  isConnectedElsewhere,
}: {
  channelId: string;
  channelName: string;
  isConnecting: boolean;
  isConnectedElsewhere: boolean;
}) {
  const { connect } = useVoiceConnection();

  return (
    <>
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-bg-surface">
        <SpeakerHighIcon
          size={24}
          className="text-text-subtle"
          aria-hidden="true"
        />
      </div>
      <p className="text-sm text-text-muted">
        {isConnectedElsewhere
          ? 'You are connected to another voice channel.'
          : 'No one is here yet. Join to start talking.'}
      </p>
      <button
        type="button"
        disabled={isConnecting}
        onClick={() => connect(channelId, channelName)}
        className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-black transition-colors hover:bg-accent-hover disabled:opacity-50"
      >
        {isConnecting
          ? 'Connecting...'
          : isConnectedElsewhere
            ? 'Switch Channel'
            : 'Join Voice'}
      </button>
    </>
  );
}

function ConnectedView({
  channelId,
  serverId,
}: {
  channelId: string;
  serverId?: string;
}) {
  const canScreenShare = useVoiceStore((s) => s.canScreenShare);
  const { localParticipant } = useLocalParticipant();
  const localSpeaking = useLocalSpeaking();
  const participants = useParticipants({
    updateOnlyOn: [
      RoomEvent.ParticipantConnected,
      RoomEvent.ParticipantDisconnected,
      RoomEvent.TrackMuted,
      RoomEvent.TrackUnmuted,
      RoomEvent.TrackPublished,
      RoomEvent.TrackUnpublished,
    ],
  });

  // Stable key for profile-fetch effect (primitive string, safe as dep)
  const participantIdKey = participants.map((p) => p.identity).join(',');
  const inflightProfiles = useRef(new Set<string>());

  // Fetch missing user profiles for avatars
  useEffect(() => {
    const profiles = useUsersStore.getState().profiles;
    for (const userId of participantIdKey.split(',')) {
      if (
        userId &&
        !profiles[userId] &&
        !inflightProfiles.current.has(userId)
      ) {
        inflightProfiles.current.add(userId);
        getProfile(userId)
          .catch((err) => {
            console.warn(
              `[VoicePanel] Failed to fetch profile for ${userId}:`,
              err,
            );
          })
          .finally(() => inflightProfiles.current.delete(userId));
      }
    }
  }, [participantIdKey]);

  return (
    <div className="flex w-full max-w-md flex-col gap-2">
      {/* Screen share thumbnails */}
      <ScreenShareGrid channelId={channelId} />

      {/* Participant list */}
      <div className="flex flex-col gap-1">
        {participants.map((p) => (
          <ParticipantRow
            key={p.identity}
            participant={p}
            isLocal={p.identity === localParticipant.identity}
            localSpeaking={localSpeaking}
            serverId={serverId}
            channelId={channelId}
          />
        ))}
      </div>

      {/* Controls */}
      <div className="mt-4 flex items-center justify-center">
        <div className="inline-flex items-center rounded-lg bg-bg-surface overflow-hidden divide-x divide-border/50">
          <MuteButton />
          <DeafenButton />
          {canScreenShare && <ScreenShareButton />}
          <DisconnectButton />
        </div>
      </div>

      {/* Soundboard */}
      <SoundboardPanel serverId={serverId} />
    </div>
  );
}

function ParticipantRow({
  participant,
  isLocal,
  localSpeaking,
  serverId,
  channelId,
}: {
  participant: Participant;
  isLocal: boolean;
  localSpeaking: boolean;
  serverId?: string;
  channelId: string;
}) {
  const livekitSpeaking = useIsSpeaking(participant);
  const isSpeaking = isLocal ? localSpeaking : livekitSpeaking;
  const isMuted = !participant.isMicrophoneEnabled;
  const isScreenSharing = participant.isScreenShareEnabled;
  const [showVolume, setShowVolume] = useState(false);
  const userId = participant.identity;
  const isDeafened = useVoiceParticipantsStore(
    (s) =>
      s.byChannel[channelId]?.some(
        (p) => p.userId === userId && p.isDeafened,
      ) ?? false,
  );
  const displayName = useDisplayName(userId, serverId);
  const avatarUrl = useUsersStore((s) => s.profiles[userId]?.avatarUrl);
  const perUserVolume = useAudioSettingsStore(
    (s) => s.perUserVolumes[userId] ?? 1.0,
  );
  const outputVolume = useAudioSettingsStore((s) => s.outputVolume);

  return (
    <div>
      <div
        className={`flex items-center gap-2 rounded-md px-2 py-1.5 transition-colors ${
          isSpeaking ? 'bg-bg-surface' : ''
        }`}
      >
        {/* Avatar with speaking ring + presence dot */}
        <ProfilePopoverCard userId={userId} serverId={serverId}>
          <button type="button" className="relative cursor-pointer">
            <div
              className={`rounded-full transition-shadow ${
                isSpeaking
                  ? 'ring-[2.5px] ring-success shadow-[0_0_6px_rgba(0,196,118,0.4)]'
                  : ''
              }`}
            >
              <Avatar
                avatarUrl={avatarUrl}
                displayName={displayName}
                size="lg"
              />
            </div>
            <PresenceDot
              userId={userId}
              size="sm"
              className="absolute -bottom-0.5 -right-0.5 ring-2 ring-bg-base"
            />
          </button>
        </ProfilePopoverCard>

        {/* Name */}
        <span
          className={`flex-1 truncate text-sm ${isMuted || isDeafened ? 'text-text-muted' : 'text-text'}`}
        >
          {displayName}
          {isLocal && <span className="ml-1 text-text-subtle">(you)</span>}
        </span>

        {/* Screen share indicator */}
        {isScreenSharing && (
          <span className="text-error" title="Sharing screen">
            <VideoCameraIcon weight="fill" size={14} aria-hidden="true" />
          </span>
        )}

        {/* Deafened indicator (implies muted, so hide mute icon) */}
        {isDeafened ? (
          <span title="Deafened">
            <EarSlashIcon size={14} className="text-error" aria-hidden="true" />
          </span>
        ) : (
          isMuted && (
            <span title="Muted">
              <MicrophoneSlashIcon
                size={14}
                className="text-text-subtle"
                aria-hidden="true"
              />
            </span>
          )
        )}

        {/* Per-user volume button (remote participants only) */}
        {!isLocal && (
          <button
            type="button"
            onClick={() => setShowVolume(!showVolume)}
            className="rounded-sm p-0.5 text-text-subtle hover:text-text transition-colors"
            title="Adjust volume"
          >
            <SpeakerHighIcon size={14} aria-hidden="true" />
          </button>
        )}
      </div>

      {/* Per-user volume slider */}
      {showVolume && !isLocal && (
        <div className="ml-10 flex items-center gap-2 rounded-md bg-bg-surface px-2 py-1">
          <SpeakerHighIcon
            size={12}
            className="text-text-subtle"
            aria-hidden="true"
          />
          <input
            type="range"
            min={0}
            max={200}
            step={1}
            value={Math.round(perUserVolume * 100)}
            onChange={(e) => {
              const newVolume = Number(e.target.value) / 100;
              useAudioSettingsStore
                .getState()
                .setPerUserVolume(userId, newVolume);
              // Apply immediately via LiveKit
              if ('setVolume' in participant) {
                try {
                  (participant as { setVolume: (v: number) => void }).setVolume(
                    outputVolume * newVolume,
                  );
                } catch {
                  // GainNode may not be ready if the track is still attaching
                }
              }
            }}
            className="flex-1 accent-accent [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-accent"
            aria-label={`Volume for ${displayName}`}
            aria-valuemin={0}
            aria-valuemax={200}
            aria-valuenow={Math.round(perUserVolume * 100)}
          />
          <span className="w-10 text-right text-xs tabular-nums text-text-muted">
            {Math.round(perUserVolume * 100)}%
          </span>
        </div>
      )}
    </div>
  );
}

function MuteButton() {
  const { localParticipant } = useLocalParticipant();
  const isMicEnabled = localParticipant.isMicrophoneEnabled;

  return (
    <button
      type="button"
      onClick={() => {
        const newEnabled = toggleMute();
        if (newEnabled !== null) {
          const { soundEnabled, enabledSounds } =
            useNotificationSettingsStore.getState();
          const type = newEnabled ? 'unmute' : 'mute';
          if (soundEnabled && enabledSounds[type]) soundManager.play(type);
        }
      }}
      className={`px-4 py-3 transition-colors hover:bg-bg-elevated ${
        isMicEnabled ? 'text-text-muted' : 'text-text'
      }`}
      title={isMicEnabled ? 'Mute' : 'Unmute'}
    >
      {isMicEnabled ? (
        <MicrophoneIcon size={22} aria-hidden="true" />
      ) : (
        <MicrophoneSlashIcon size={22} aria-hidden="true" />
      )}
    </button>
  );
}

function DeafenButton() {
  const isDeafened = useVoiceStore((s) => s.isDeafened);

  return (
    <button
      type="button"
      onClick={() => {
        const newDeafened = toggleDeafen();
        if (newDeafened !== null) {
          const { soundEnabled, enabledSounds } =
            useNotificationSettingsStore.getState();
          const type = newDeafened ? 'mute' : 'unmute';
          if (soundEnabled && enabledSounds[type]) soundManager.play(type);
        }
      }}
      className={`px-4 py-3 transition-colors hover:bg-bg-elevated ${
        isDeafened ? 'text-error' : 'text-text-muted'
      }`}
      title={isDeafened ? 'Undeafen' : 'Deafen'}
    >
      {isDeafened ? (
        <EarSlashIcon size={22} aria-hidden="true" />
      ) : (
        <EarIcon size={22} aria-hidden="true" />
      )}
    </button>
  );
}

function DisconnectButton() {
  const { disconnect } = useVoiceConnection();

  return (
    <button
      type="button"
      onClick={disconnect}
      className="px-4 py-3 text-error transition-colors hover:bg-error/10"
      title="Disconnect"
    >
      <PhoneSlashIcon size={22} aria-hidden="true" />
    </button>
  );
}

function ScreenShareButton() {
  const { localParticipant } = useLocalParticipant();
  const isSharing = localParticipant.isScreenShareEnabled;
  const isToggling = useRef(false);
  const isMobile = useMobile();

  // Hide on mobile or if getDisplayMedia is not available.
  if (
    isMobile ||
    typeof navigator.mediaDevices?.getDisplayMedia !== 'function'
  ) {
    return null;
  }

  const toggle = async () => {
    if (isToggling.current) return;
    isToggling.current = true;
    try {
      if (isSharing) {
        await localParticipant.setScreenShareEnabled(false);
      } else {
        const state = useStreamSettingsStore.getState();
        await localParticipant.setScreenShareEnabled(
          true,
          buildCaptureOptions(state),
          buildPublishOptions(state),
        );
      }
    } catch {
      // User cancelled the picker or getDisplayMedia failed — no-op.
    } finally {
      isToggling.current = false;
    }
  };

  return (
    <button
      type="button"
      onClick={toggle}
      className={`px-4 py-3 transition-colors hover:bg-bg-elevated ${
        isSharing ? 'text-success' : 'text-text-muted'
      }`}
      title={isSharing ? 'Stop sharing' : 'Share screen'}
    >
      {isSharing ? (
        <MonitorIcon size={22} aria-hidden="true" />
      ) : (
        <MonitorArrowUpIcon size={22} aria-hidden="true" />
      )}
    </button>
  );
}

function ScreenShareGrid({ channelId }: { channelId: string }) {
  const allTracks = useTracks([Track.Source.ScreenShare]);
  const tracks = allTracks.filter(
    (t): t is TrackReference => t.publication !== undefined,
  );

  if (tracks.length === 0) return null;

  const handlePopOut = (trackRef: (typeof tracks)[number]) => {
    const state = useTilingStore.getState();
    const { panes, focusedPaneId, splitFocused, setPaneContent, focusPane } =
      state;
    const identity = trackRef.participant.identity;
    const name = resolveDisplayName(identity);

    // Dedup: if a pane already shows this participant's screen share, focus it
    const existingPaneId = Object.entries(panes).find(
      ([, content]) =>
        content.type === 'screenShare' &&
        content.participantIdentity === identity,
    )?.[0];

    if (existingPaneId) {
      focusPane(existingPaneId);
      return;
    }

    const newContent = {
      type: 'screenShare' as const,
      channelId,
      participantIdentity: identity,
      participantName: name,
    };

    // If at max panes, replace the focused pane instead of splitting
    if (paneCount(state.root) >= MAX_PANES) {
      setPaneContent(focusedPaneId, newContent);
      return;
    }

    splitFocused('horizontal', newContent);
  };

  return (
    <div
      className={`grid gap-2 p-2 ${tracks.length === 1 ? 'grid-cols-1' : 'grid-cols-2'}`}
    >
      {tracks.map((trackRef) => (
        <ScreenShareThumbnail
          key={trackRef.participant.identity}
          trackRef={trackRef}
          onPopOut={() => handlePopOut(trackRef)}
        />
      ))}
    </div>
  );
}

function ScreenShareThumbnail({
  trackRef,
  onPopOut,
}: {
  trackRef: TrackReference;
  onPopOut: () => void;
}) {
  const userId = trackRef.participant.identity;
  const displayName = useDisplayName(userId);

  return (
    // biome-ignore lint/a11y/useSemanticElements: div with role=button needed for click-to-pop-out
    <div
      className="relative aspect-video overflow-hidden rounded-md bg-black ring-1 ring-border hover:ring-accent transition-all cursor-pointer"
      title={`${displayName}'s screen — click to pop out`}
      onClick={onPopOut}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onPopOut();
      }}
      role="button"
      tabIndex={0}
    >
      <VideoTrack
        trackRef={trackRef}
        className="h-full w-full object-contain"
      />
      <span className="absolute bottom-1 left-1 rounded bg-black/70 px-1.5 py-0.5 text-xs text-white">
        {displayName}
      </span>
      <ThumbnailAudioToggle participantIdentity={userId} />
    </div>
  );
}

function ThumbnailAudioToggle({
  participantIdentity,
}: {
  participantIdentity: string;
}) {
  const participants = useRemoteParticipants();
  const participant = participants.find(
    (p) => p.identity === participantIdentity,
  );
  const [isMuted, setIsMuted] = useState(true);

  if (!participant) return null;

  const toggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    const newMuted = !isMuted;
    try {
      participant.setVolume(newMuted ? 0 : 1, Track.Source.ScreenShareAudio);
    } catch {
      // GainNode may not be ready if the track is still attaching
    }
    setIsMuted(newMuted);
  };

  return (
    <button
      type="button"
      onClick={toggle}
      className={`absolute bottom-1 right-1 rounded p-0.5 text-xs transition-colors ${
        isMuted
          ? 'bg-black/70 text-white/70 hover:bg-black/90'
          : 'bg-accent/80 text-black hover:bg-accent'
      }`}
      title={isMuted ? 'Unmute stream audio' : 'Mute stream audio'}
    >
      {isMuted ? (
        <SpeakerSlashIcon size={14} aria-hidden="true" />
      ) : (
        <SpeakerHighIcon size={14} aria-hidden="true" />
      )}
    </button>
  );
}
