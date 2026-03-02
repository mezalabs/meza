/**
 * Mobile voice connection hook.
 *
 * Mirrors web's useVoiceConnection but without tiling/soundboard/sound-manager
 * since those are desktop-only features.
 */

import {
  joinVoiceChannel,
  leaveVoiceChannel,
  mapVoiceError,
  useAuthStore,
  useVoiceParticipantsStore,
  useVoiceStore,
} from '@meza/core';

export async function voiceConnect(channelId: string, channelName: string) {
  const state = useVoiceStore.getState();

  // Auto-leave previous channel
  if (
    state.channelId &&
    state.channelId !== channelId &&
    state.status === 'connected'
  ) {
    await leaveVoiceChannel(state.channelId).catch(() => {});
  }

  // Prevent double-join
  if (state.status === 'connecting') return;

  useVoiceStore.getState().setConnecting(channelId, channelName);

  // Optimistic: show local user in channel immediately
  const userId = useAuthStore.getState().user?.id;
  if (userId) {
    useVoiceParticipantsStore.getState().upsertParticipant(channelId, {
      userId,
      isMuted: false,
      isDeafened: false,
      isStreamingVideo: false,
    });
  }

  try {
    const res = await joinVoiceChannel(channelId);
    useVoiceStore
      .getState()
      .setConnected(res.livekitUrl, res.livekitToken, res.canScreenShare);
  } catch (err) {
    // Rollback optimistic add on failure
    if (userId) {
      useVoiceParticipantsStore.getState().removeParticipant(channelId, userId);
    }
    useVoiceStore.getState().setError(mapVoiceError(err));
  }
}

export function voiceDisconnect() {
  const state = useVoiceStore.getState();
  if (state.channelId) {
    // Optimistic: remove local user from channel immediately
    const userId = useAuthStore.getState().user?.id;
    if (userId) {
      useVoiceParticipantsStore
        .getState()
        .removeParticipant(state.channelId, userId);
    }
    leaveVoiceChannel(state.channelId).catch(() => {});
  }
  useVoiceStore.getState().disconnect();
}

export function useVoiceConnection() {
  return { connect: voiceConnect, disconnect: voiceDisconnect };
}
