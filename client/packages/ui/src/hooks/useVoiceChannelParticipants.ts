import {
  ChannelType,
  getProfile,
  getVoiceChannelState,
  useChannelStore,
  useUsersStore,
  useVoiceParticipantsStore,
} from '@meza/core';
import { useEffect, useRef } from 'react';

const POLL_INTERVAL = 10_000;

export function useVoiceChannelParticipants(
  serverId: string | null,
  isAuthenticated: boolean,
) {
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!isAuthenticated || !serverId) {
      useVoiceParticipantsStore.getState().clearAll();
      return;
    }

    const fetchAll = () => {
      const channels = useChannelStore.getState().byServer[serverId] ?? [];
      const voiceChannels = channels.filter(
        (ch) => ch.type === ChannelType.VOICE,
      );

      for (const ch of voiceChannels) {
        getVoiceChannelState(ch.id)
          .then((res) => {
            useVoiceParticipantsStore.getState().setParticipants(
              ch.id,
              res.participants.map((p) => ({
                userId: p.userId,
                isMuted: p.isMuted,
                isDeafened: p.isDeafened,
                isStreamingVideo: p.isStreamingVideo,
              })),
            );

            const profiles = useUsersStore.getState().profiles;
            for (const p of res.participants) {
              if (!profiles[p.userId]) {
                getProfile(p.userId).catch(() => {});
              }
            }
          })
          .catch(() => {
            useVoiceParticipantsStore.getState().clearChannel(ch.id);
          });
      }
    };

    fetchAll();
    intervalRef.current = setInterval(fetchAll, POLL_INTERVAL);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      useVoiceParticipantsStore.getState().clearAll();
    };
  }, [serverId, isAuthenticated]);
}
