import { Code, ConnectError, createClient } from '@connectrpc/connect';
import { ChatService } from '@meza/gen/meza/v1/chat_pb.ts';
import type {
  Bot,
  BotInvite,
  BotWithToken,
  IncomingWebhook,
  IncomingWebhookWithSecret,
} from '@meza/gen/meza/v1/models_pb.ts';
import { transport } from './client.ts';

const chatClient = createClient(ChatService, transport);

function mapBotError(err: unknown): string {
  if (err instanceof ConnectError) {
    switch (err.code) {
      case Code.PermissionDenied:
        return 'You do not have permission to perform this action';
      case Code.NotFound:
        return 'Bot not found';
      case Code.InvalidArgument:
        return err.message.includes('username')
          ? 'Invalid username. Use only lowercase letters, numbers, and underscores.'
          : 'Invalid input. Please check your request.';
      case Code.AlreadyExists:
        return 'A bot with that username already exists';
      case Code.ResourceExhausted:
        return 'You have reached the maximum number of bots (25)';
      case Code.Unauthenticated:
        return 'Your session has expired. Please log in again.';
      case Code.Internal:
        return 'Something went wrong. Please try again.';
      default:
        console.error('Unmapped ConnectError:', err.code, err.message);
        return 'Something went wrong. Please try again.';
    }
  }
  return 'Network error. Please check your connection.';
}

export async function createBot(
  username: string,
  displayName: string,
): Promise<BotWithToken | undefined> {
  try {
    const res = await chatClient.createBot({ username, displayName });
    return res.bot;
  } catch (err) {
    throw new Error(mapBotError(err));
  }
}

export async function deleteBot(botId: string): Promise<void> {
  try {
    await chatClient.deleteBot({ botId });
  } catch (err) {
    throw new Error(mapBotError(err));
  }
}

export async function regenerateBotToken(
  botId: string,
): Promise<{ token: string } | undefined> {
  try {
    const res = await chatClient.regenerateBotToken({ botId });
    return res.token ? { token: res.token } : undefined;
  } catch (err) {
    throw new Error(mapBotError(err));
  }
}

export async function listBots(): Promise<Bot[]> {
  try {
    const res = await chatClient.listBots({});
    return res.bots;
  } catch (err) {
    throw new Error(mapBotError(err));
  }
}

export async function getBot(botId: string): Promise<Bot | undefined> {
  try {
    const res = await chatClient.getBot({ botId });
    return res.bot;
  } catch (err) {
    throw new Error(mapBotError(err));
  }
}

export async function updateBot(
  botId: string,
  fields: {
    displayName?: string;
    description?: string;
    avatarUrl?: string;
  },
): Promise<Bot | undefined> {
  try {
    const res = await chatClient.updateBot({ botId, ...fields });
    return res.bot;
  } catch (err) {
    throw new Error(mapBotError(err));
  }
}

export async function createBotInvite(
  botId: string,
  requestedPermissions: bigint,
): Promise<BotInvite | undefined> {
  try {
    const res = await chatClient.createBotInvite({
      botId,
      requestedPermissions,
    });
    return res.invite;
  } catch (err) {
    throw new Error(mapBotError(err));
  }
}

export async function resolveBotInvite(code: string) {
  try {
    const res = await chatClient.resolveBotInvite({ code });
    return res;
  } catch (err) {
    throw new Error(mapBotError(err));
  }
}

export async function acceptBotInvite(
  code: string,
  serverId: string,
): Promise<void> {
  try {
    await chatClient.acceptBotInvite({ code, serverId });
  } catch (err) {
    throw new Error(mapBotError(err));
  }
}

export async function listBotInvites(
  botId: string,
): Promise<BotInvite[]> {
  try {
    const res = await chatClient.listBotInvites({ botId });
    return res.invites;
  } catch (err) {
    throw new Error(mapBotError(err));
  }
}

export async function deleteBotInvite(code: string): Promise<void> {
  try {
    await chatClient.deleteBotInvite({ code });
  } catch (err) {
    throw new Error(mapBotError(err));
  }
}

export async function createIncomingWebhook(
  botId: string,
  serverId: string,
  channelId: string,
): Promise<IncomingWebhookWithSecret | undefined> {
  try {
    const res = await chatClient.createIncomingWebhook({
      botId,
      serverId,
      channelId,
    });
    return res.webhook;
  } catch (err) {
    throw new Error(mapBotError(err));
  }
}

export async function deleteIncomingWebhook(
  webhookId: string,
): Promise<void> {
  try {
    await chatClient.deleteIncomingWebhook({ webhookId });
  } catch (err) {
    throw new Error(mapBotError(err));
  }
}

export async function listIncomingWebhooks(
  serverId: string,
): Promise<IncomingWebhook[]> {
  try {
    const res = await chatClient.listIncomingWebhooks({ serverId });
    return res.webhooks;
  } catch (err) {
    throw new Error(mapBotError(err));
  }
}
