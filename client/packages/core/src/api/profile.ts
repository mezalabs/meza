import { createClient } from '@connectrpc/connect';
import { ChatService } from '@meza/gen/meza/v1/chat_pb.ts';
import type { Server } from '@meza/gen/meza/v1/models_pb.ts';
import { VoiceService } from '@meza/gen/meza/v1/voice_pb.ts';
import type { StoredUser } from '../store/auth.ts';
import { toStoredUser } from './auth.ts';
import { transport } from './client.ts';

const chatClient = createClient(ChatService, transport);
const voiceClient = createClient(VoiceService, transport);

export interface StoredServer {
  id: string;
  name: string;
  iconUrl: string;
}

export interface VoiceActivity {
  channelId: string;
  channelName: string;
  serverId: string;
  serverName: string;
  isStreamingVideo: boolean;
}

function toStoredServer(server: Server): StoredServer {
  return {
    id: server.id,
    name: server.name,
    iconUrl: server.iconUrl,
  };
}

export async function getMutualServers(
  userId: string,
): Promise<StoredServer[]> {
  const res = await chatClient.getMutualServers({ userId });
  return res.servers.map(toStoredServer);
}

export async function getMutualFriends(userId: string): Promise<StoredUser[]> {
  const res = await chatClient.getMutualFriends({ userId });
  return res.users.map(toStoredUser);
}

export async function getUserVoiceActivity(
  userId: string,
): Promise<VoiceActivity[]> {
  const res = await voiceClient.getUserVoiceActivity({ userId });
  return res.activities.map((a) => ({
    channelId: a.channelId,
    channelName: a.channelName,
    serverId: a.serverId,
    serverName: a.serverName,
    isStreamingVideo: a.isStreamingVideo,
  }));
}
