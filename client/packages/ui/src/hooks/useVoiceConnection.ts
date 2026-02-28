import {
  joinVoiceChannel,
  leaveVoiceChannel,
  mapVoiceError,
  soundManager,
  useAuthStore,
  useNotificationSettingsStore,
  useVoiceParticipantsStore,
  useVoiceStore,
} from '@meza/core';
import { useTilingStore } from '../stores/tiling.ts';

function isWebRTCAvailable(): boolean {
  return (
    typeof RTCPeerConnection !== 'undefined' &&
    typeof navigator.mediaDevices !== 'undefined' &&
    typeof navigator.mediaDevices.getUserMedia !== 'undefined'
  );
}

export async function voiceConnect(channelId: string, channelName: string) {
  if (!isWebRTCAvailable()) {
    useVoiceStore
      .getState()
      .setError(
        "You're on a privacy-focused browser. Great taste :) If you want to voice chat, enable media.peerconnection.enabled in about:config. You may also need to set media.peerconnection.ice.no_host and media.peerconnection.ice.proxy_only_if_behind_proxy to false.",
      );
    return;
  }

  const state = useVoiceStore.getState();

  // Auto-leave previous channel (Discord pattern: no confirmation)
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
    const { soundEnabled, enabledSounds } =
      useNotificationSettingsStore.getState();
    if (soundEnabled && enabledSounds['call-connect']) {
      soundManager.play('call-connect');
    }
  } catch (err) {
    // Rollback optimistic add on failure
    if (userId) {
      useVoiceParticipantsStore
        .getState()
        .removeParticipant(channelId, userId);
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
    // Close voice and screen-share panes for this channel in a single update
    const disconnectedChannelId = state.channelId;
    useTilingStore.getState().closePanesMatching(
      (content) =>
        (content.type === 'voice' || content.type === 'screenShare') &&
        content.channelId === disconnectedChannelId,
    );
  }
  useVoiceStore.getState().disconnect();
  const { soundEnabled, enabledSounds } =
    useNotificationSettingsStore.getState();
  if (soundEnabled && enabledSounds['call-end']) {
    soundManager.play('call-end');
  }
}

/** Stable hook — returns the same function references across renders. */
export function useVoiceConnection() {
  return { connect: voiceConnect, disconnect: voiceDisconnect };
}
