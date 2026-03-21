import {
  useRemoteParticipants,
  useRoomContext,
  useTracks,
  VideoTrack,
} from '@livekit/components-react';
import type { PaneId, ViewerQuality } from '@meza/core';
import { useChannelStore, useStreamSettingsStore } from '@meza/core';
import {
  MonitorIcon,
  SpeakerHighIcon,
  SpeakerSlashIcon,
} from '@phosphor-icons/react';
import { type RemoteParticipant, Track, VideoQuality } from 'livekit-client';
import { useEffect, useState } from 'react';
import { useDisplayName } from '../../hooks/useDisplayName.ts';
import { useTilingStore } from '../../stores/tiling.ts';
import { viewerQualityToVideoQuality } from '../../utils/streamPresets.ts';

const encoder = new TextEncoder();
const STREAM_VIEWER_TOPIC = 'meza:stream-viewer';

interface ScreenSharePaneProps {
  paneId: PaneId;
  participantIdentity: string;
  channelId: string;
}

export function ScreenSharePane({
  paneId,
  participantIdentity,
  channelId,
}: ScreenSharePaneProps) {
  const tracks = useTracks([Track.Source.ScreenShare]);
  const track = tracks.find(
    (t) => t.participant.identity === participantIdentity,
  );
  const remoteParticipants = useRemoteParticipants();
  const participant = remoteParticipants.find(
    (p) => p.identity === participantIdentity,
  );

  // Resolve serverId from channelId for display name lookup
  const serverId = useChannelStore((s) => {
    for (const [sId, channels] of Object.entries(s.byServer)) {
      if (channels.some((c) => c.id === channelId)) return sId;
    }
    return undefined;
  });
  const displayName = useDisplayName(participantIdentity, serverId);

  const room = useRoomContext();

  useEffect(() => {
    // Notify the streamer that we started watching
    room.localParticipant
      .publishData(
        encoder.encode(JSON.stringify({ type: 'join' })),
        {
          reliable: true,
          topic: STREAM_VIEWER_TOPIC,
          destinationIdentities: [participantIdentity],
        },
      )
      .catch(() => {}); // best-effort — may fail during teardown

    return () => {
      // Only send leave if room is still connected or reconnecting
      if (room.state === 'connected' || room.state === 'reconnecting') {
        room.localParticipant
          .publishData(
            encoder.encode(JSON.stringify({ type: 'leave' })),
            {
              reliable: true,
              topic: STREAM_VIEWER_TOPIC,
              destinationIdentities: [participantIdentity],
            },
          )
          .catch(() => {}); // best-effort — may fail during teardown
      }
    };
  }, [room, participantIdentity]);

  if (!track) {
    return (
      <div className="flex flex-1 min-h-0 min-w-0 flex-col items-center justify-center gap-3 bg-bg-base">
        <MonitorIcon
          size={24}
          className="text-text-subtle"
          aria-hidden="true"
        />
        <p className="text-sm text-text-muted">Stream ended</p>
        <button
          type="button"
          onClick={() => useTilingStore.getState().closePane(paneId)}
          className="rounded-md bg-bg-surface px-3 py-1.5 text-sm text-text hover:bg-bg-elevated transition-colors"
        >
          Close
        </button>
      </div>
    );
  }

  return (
    <div className="group relative flex flex-1 min-h-0 min-w-0 flex-col overflow-hidden bg-black">
      <VideoTrack trackRef={track} className="h-full w-full object-contain" />
      <div className="absolute bottom-0 inset-x-0 flex items-center gap-2 bg-gradient-to-t from-black/80 to-transparent px-3 py-2 opacity-0 group-hover:opacity-100 transition-opacity">
        <StreamAudioToggle participant={participant} />
        <StreamQualitySelector participant={participant} />
        <span className="ml-auto text-xs text-white/60">{displayName}</span>
      </div>
    </div>
  );
}

function StreamAudioToggle({
  participant,
}: {
  participant: RemoteParticipant | undefined;
}) {
  const [isMuted, setIsMuted] = useState(true);

  if (!participant) return null;

  const toggle = () => {
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
      className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-sm transition-colors ${
        isMuted
          ? 'bg-white/20 text-white hover:bg-white/30'
          : 'bg-accent/80 text-black hover:bg-accent'
      }`}
      title={isMuted ? 'Unmute stream audio' : 'Mute stream audio'}
    >
      {isMuted ? (
        <SpeakerSlashIcon size={16} aria-hidden="true" />
      ) : (
        <SpeakerHighIcon size={16} aria-hidden="true" />
      )}
      <span>{isMuted ? 'Unmute' : 'Mute'}</span>
    </button>
  );
}

function StreamQualitySelector({
  participant,
}: {
  participant: RemoteParticipant | undefined;
}) {
  const defaultQuality = useStreamSettingsStore((s) => s.defaultQuality);
  const [quality, setQuality] = useState<ViewerQuality>(defaultQuality);

  // Find the screen share track publication
  const publication = participant?.getTrackPublication(
    Track.Source.ScreenShare,
  );

  // Only show if the track is simulcasted
  if (!publication || !publication.simulcasted) return null;

  const handleChange = (newQuality: ViewerQuality) => {
    setQuality(newQuality);
    const videoQuality = viewerQualityToVideoQuality(newQuality);
    if (videoQuality !== null) {
      publication.setVideoQuality(videoQuality);
    } else {
      // 'auto' — reset to HIGH and let adaptive stream handle it
      publication.setVideoQuality(VideoQuality.HIGH);
    }
  };

  return (
    <select
      value={quality}
      onChange={(e) => handleChange(e.target.value as ViewerQuality)}
      className="rounded-md bg-white/20 px-2 py-1 text-sm text-white hover:bg-white/30 transition-colors"
      aria-label="Stream quality"
    >
      <option value="auto">Auto</option>
      <option value="high">High</option>
      <option value="medium">Medium</option>
      <option value="low">Low</option>
    </select>
  );
}
