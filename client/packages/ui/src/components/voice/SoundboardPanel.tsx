import { useRoomContext } from '@livekit/components-react';
import type { SoundState } from '@meza/core';
import {
  getMediaURL,
  listServerSounds,
  listUserSounds,
  useAudioSettingsStore,
  useAuthStore,
  useSoundStore,
} from '@meza/core';
import { LocalAudioTrack, Track } from 'livekit-client';
import { useCallback, useEffect, useRef, useState } from 'react';

type Sound = SoundState['personal'][number];

const COOLDOWN_MS = 2_500;
const EMPTY: never[] = [];

// Singleton AudioContext — created on first user interaction.
let audioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext {
  if (!audioCtx) audioCtx = new AudioContext();
  return audioCtx;
}

// AudioBuffer cache keyed by attachment ID.
const bufferCache = new Map<string, AudioBuffer>();

async function fetchAndDecode(attachmentId: string): Promise<AudioBuffer> {
  const cached = bufferCache.get(attachmentId);
  if (cached) return cached;

  const url = getMediaURL(attachmentId);
  const res = await fetch(url);
  const arrayBuf = await res.arrayBuffer();
  const ctx = getAudioContext();
  const decoded = await ctx.decodeAudioData(arrayBuf);
  bufferCache.set(attachmentId, decoded);
  return decoded;
}

interface SoundboardPanelProps {
  serverId?: string;
}

export function SoundboardPanel({ serverId }: SoundboardPanelProps) {
  const room = useRoomContext();
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const personalSounds = useSoundStore((s) => s.personal);
  const serverSounds = useSoundStore((s) =>
    serverId ? (s.byServer[serverId] ?? EMPTY) : EMPTY,
  );
  const [playingId, setPlayingId] = useState<string | null>(null);
  // Set of sound IDs currently in cooldown (drives the fill bar).
  const [cooldowns, setCooldowns] = useState<Set<string>>(() => new Set());
  // Per-sound key to restart the CSS animation on repeated plays.
  const [cooldownKeys, setCooldownKeys] = useState<Record<string, number>>({});
  const lastPlayedAtRef = useRef<Map<string, number>>(new Map());
  const trackRef = useRef<LocalAudioTrack | null>(null);
  const destRef = useRef<MediaStreamAudioDestinationNode | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);

  useEffect(() => {
    if (!isAuthenticated) return;
    listUserSounds().catch(() => {});
    if (serverId) listServerSounds(serverId).catch(() => {});
  }, [serverId, isAuthenticated]);

  // Cleanup track on unmount.
  useEffect(() => {
    return () => {
      if (trackRef.current) {
        room.localParticipant.unpublishTrack(trackRef.current).catch(() => {});
        trackRef.current.stop();
        trackRef.current = null;
      }
      destRef.current = null;
    };
  }, [room]);

  const playSound = useCallback(
    async (sound: Sound) => {
      const now = Date.now();
      const lastPlayed = lastPlayedAtRef.current.get(sound.id) ?? 0;
      if (now - lastPlayed < COOLDOWN_MS) return;

      const attachmentId = sound.audioUrl.replace('/media/', '');
      setPlayingId(sound.id);
      lastPlayedAtRef.current.set(sound.id, now);
      setCooldowns((prev) => new Set(prev).add(sound.id));
      setCooldownKeys((prev) => ({
        ...prev,
        [sound.id]: (prev[sound.id] ?? 0) + 1,
      }));

      try {
        const ctx = getAudioContext();
        if (ctx.state === 'suspended') await ctx.resume();

        // Ensure we have a persistent destination node.
        if (!destRef.current) {
          destRef.current = ctx.createMediaStreamDestination();
        }

        // Publish track if not yet published.
        if (!trackRef.current) {
          const track = new LocalAudioTrack(
            // biome-ignore lint/style/noNonNullAssertion: audio stream always has at least one track
            destRef.current.stream.getAudioTracks()[0]!,
            undefined,
            true,
          );
          await room.localParticipant.publishTrack(track, {
            source: Track.Source.Unknown,
            dtx: false,
          });
          trackRef.current = track;
        }

        const buffer = await fetchAndDecode(attachmentId);

        // Stop any currently playing source.
        if (sourceRef.current) {
          sourceRef.current.onended = null;
          sourceRef.current.stop();
        }

        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(destRef.current);
        if (useAudioSettingsStore.getState().hearOwnSoundboard) {
          source.connect(ctx.destination);
        }
        source.onended = () => {
          setPlayingId(null);
          sourceRef.current = null;
        };
        sourceRef.current = source;
        source.start();
      } catch {
        setPlayingId(null);
      }
    },
    [room],
  );

  const allSounds = [...personalSounds, ...serverSounds];

  if (allSounds.length === 0) return null;

  return (
    <div className="mt-4 w-full">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-text-subtle">
        Soundboard
      </h3>
      <div className="flex flex-wrap gap-1.5">
        {allSounds.map((sound) => (
          <button
            key={sound.id}
            type="button"
            onClick={() => playSound(sound)}
            className={`relative overflow-hidden rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors ${
              playingId === sound.id
                ? 'bg-accent text-black'
                : 'bg-bg-surface text-text hover:bg-bg-elevated'
            }`}
            title={
              sound.serverId
                ? `Server: ${sound.name}`
                : `Personal: ${sound.name}`
            }
          >
            {sound.name}
            {cooldowns.has(sound.id) && (
              <span
                key={cooldownKeys[sound.id]}
                className="absolute bottom-0 left-0 h-0.5 bg-accent"
                style={{
                  animation: `soundboard-cooldown ${COOLDOWN_MS}ms linear forwards`,
                }}
                onAnimationEnd={() =>
                  setCooldowns((prev) => {
                    const next = new Set(prev);
                    next.delete(sound.id);
                    return next;
                  })
                }
              />
            )}
          </button>
        ))}
      </div>
      <style>{`
        @keyframes soundboard-cooldown {
          from { width: 0%; }
          to { width: 100%; }
        }
      `}</style>
    </div>
  );
}
