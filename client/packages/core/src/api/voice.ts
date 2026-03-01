import { Code, ConnectError, createClient } from '@connectrpc/connect';
import { VoiceService } from '@meza/gen/meza/v1/voice_pb.ts';
import { transport } from './client.ts';

const voiceClient = createClient(VoiceService, transport);

export function mapVoiceError(err: unknown): string {
  if (err instanceof ConnectError) {
    switch (err.code) {
      case Code.Unauthenticated:
        return 'You must be logged in';
      case Code.PermissionDenied:
        return 'You do not have access to this voice channel';
      case Code.NotFound:
        return 'Voice channel not found';
      case Code.InvalidArgument:
        return 'Invalid voice channel';
      default:
        return 'Failed to connect to voice';
    }
  }
  return 'An unexpected error occurred';
}

export async function joinVoiceChannel(channelId: string) {
  return voiceClient.joinVoiceChannel({ channelId });
}

export async function leaveVoiceChannel(channelId: string) {
  return voiceClient.leaveVoiceChannel({ channelId });
}

export async function getVoiceChannelState(channelId: string) {
  return voiceClient.getVoiceChannelState({ channelId });
}
