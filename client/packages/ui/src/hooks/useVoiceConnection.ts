import {
  deriveVoiceKey,
  fetchAndCacheChannelKeys,
  getChannelKey,
  getLatestKeyVersion,
  joinVoiceChannel,
  leaveVoiceChannel,
  mapVoiceError,
  soundManager,
  useAuthStore,
  useNotificationSettingsStore,
  useVoiceParticipantsStore,
  useVoiceStore,
} from '@meza/core';
import { isE2EESupported } from 'livekit-client';
import { e2eeKeyProvider } from '../components/voice/PersistentVoiceConnection.tsx';
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

  // Block unsupported browsers — mixed encrypted/unencrypted causes silent failure
  if (!isE2EESupported()) {
    useVoiceStore
      .getState()
      .setError(
        'Your browser does not support encrypted voice calls. Please update to Chrome 86+, Firefox 117+, or Safari 15.4+.',
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
    // Fetch channel key and join RPC in parallel (independent operations)
    const [, res] = await Promise.all([
      fetchAndCacheChannelKeys(channelId),
      joinVoiceChannel(channelId),
    ]);

    // Derive voice-specific subkey via HKDF (domain separation from text encryption)
    const keyVersion = getLatestKeyVersion(channelId);
    if (keyVersion === null) {
      throw new Error('Encryption key unavailable');
    }
    const channelKey = await getChannelKey(channelId, keyVersion);
    if (!channelKey) {
      throw new Error('Encryption key unavailable');
    }
    const voiceKey = await deriveVoiceKey(channelKey, channelId);

    // Set key on provider BEFORE LiveKitRoom connects.
    // Defensive copy — never share the backing ArrayBuffer with the channel key cache.
    await e2eeKeyProvider.setKey(new Uint8Array(voiceKey).buffer as ArrayBuffer);

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
    // Close voice and screen-share panes for this channel in a single update
    const disconnectedChannelId = state.channelId;
    useTilingStore
      .getState()
      .closePanesMatching(
        (content) =>
          (content.type === 'voice' || content.type === 'screenShare') &&
          content.channelId === disconnectedChannelId,
      );
  }
  useVoiceStore.getState().disconnect();
  // Clear E2EE key material from provider
  e2eeKeyProvider.setKey(new ArrayBuffer(0));
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
