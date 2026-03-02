import {
  useAudioSettingsStore,
  useVoiceParticipantsStore,
  useVoiceStore,
} from '@meza/core';
import type { Room } from 'livekit-client';

/**
 * Module-scoped ref to the LiveKit room instance.
 * Set by PersistentVoiceConnection on mount, cleared on unmount.
 */
let roomRef: Room | null = null;

export function setVoiceRoom(room: Room | null) {
  roomRef = room;
}

export function getVoiceRoom(): Room | null {
  return roomRef;
}

/**
 * Toggle the local microphone. Returns the new enabled state
 * (true = mic on, false = mic off), or null if no room.
 */
export function toggleMute(): boolean | null {
  if (!roomRef) return null;
  const lp = roomRef.localParticipant;
  const wasEnabled = lp.isMicrophoneEnabled;
  const newEnabled = !wasEnabled;
  lp.setMicrophoneEnabled(newEnabled).catch(() => {});

  // Update participants store for immediate sidebar feedback
  const channelId = useVoiceStore.getState().channelId;
  if (channelId) {
    useVoiceParticipantsStore
      .getState()
      .updateParticipant(channelId, lp.identity, { isMuted: !newEnabled });
  }

  return newEnabled;
}

/**
 * Toggle self-deafen. Returns the new deafened state
 * (true = deafened, false = undeafened), or null if no room.
 *
 * Deafen: mutes mic + silences all incoming audio.
 * Undeafen: restores pre-deafen mute state + restores remote volumes.
 */
export function toggleDeafen(): boolean | null {
  if (!roomRef) return null;
  const voiceState = useVoiceStore.getState();
  const newDeafened = !voiceState.isDeafened;

  if (newDeafened) {
    // Save current mute state before deafening
    voiceState.setPreDeafenMuteState(
      !roomRef.localParticipant.isMicrophoneEnabled,
    );
    // Mute mic
    roomRef.localParticipant.setMicrophoneEnabled(false).catch(() => {});
    // Silence all remote audio
    for (const p of roomRef.remoteParticipants.values()) {
      try {
        p.setVolume(0);
      } catch {
        // GainNode may not be ready
      }
    }
  } else {
    // Restore pre-deafen mute state
    const wasMuted = voiceState.preDeafenMuteState;
    if (!wasMuted) {
      roomRef.localParticipant.setMicrophoneEnabled(true).catch(() => {});
    }
    // Restore remote audio to per-user/global volumes
    const { outputVolume, perUserVolumes } = useAudioSettingsStore.getState();
    for (const p of roomRef.remoteParticipants.values()) {
      const perUser = perUserVolumes[p.identity] ?? 1.0;
      try {
        p.setVolume(outputVolume * perUser);
      } catch {
        // GainNode may not be ready
      }
    }
  }

  // Update store state
  voiceState.setDeafened(newDeafened);

  // Update participants store for immediate sidebar feedback
  const channelId = voiceState.channelId;
  if (channelId && roomRef) {
    useVoiceParticipantsStore
      .getState()
      .updateParticipant(channelId, roomRef.localParticipant.identity, {
        isDeafened: newDeafened,
        isMuted: newDeafened ? true : voiceState.preDeafenMuteState,
      });
  }

  // Broadcast deafen state via LiveKit data channel
  const encoder = new TextEncoder();
  roomRef.localParticipant
    .publishData(
      encoder.encode(
        JSON.stringify({ type: 'deafen', isDeafened: newDeafened }),
      ),
      { reliable: true },
    )
    .catch(() => {});

  return newDeafened;
}
