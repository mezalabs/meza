/**
 * Spoke-specific wrappers for core write operations.
 *
 * These mirror the origin API functions in chat.ts but route through
 * the spoke transport. The caller determines if the server is federated
 * and uses the spoke variant.
 */
import { type Client, createClient } from '@connectrpc/connect';
import { ChatService } from '@meza/gen/meza/v1/chat_pb.ts';
import { useFederationStore } from '../store/federation.ts';
import { mapFederationError } from './federation.ts';
import { getSpokeTransport } from './federation-transport.ts';

type SpokeChat = Client<typeof ChatService>;

function getSpokeChat(serverId: string): SpokeChat {
  const instanceUrl = useFederationStore.getState().serverIndex[serverId];
  if (!instanceUrl) throw new Error('Not a federated server');
  return createClient(ChatService, getSpokeTransport(instanceUrl));
}

async function withSpokeError<T>(
  serverId: string,
  fn: (client: SpokeChat) => Promise<T>,
): Promise<T> {
  try {
    return await fn(getSpokeChat(serverId));
  } catch (err) {
    throw new Error(mapFederationError(err), { cause: err });
  }
}

export function spokeSendMessage(
  serverId: string,
  params: {
    channelId: string;
    encryptedContent: Uint8Array;
    keyVersion?: number;
    nonce: string;
    attachmentIds?: string[];
    replyToId?: string;
    mentionedUserIds?: string[];
    mentionedRoleIds?: string[];
    mentionEveryone?: boolean;
  },
) {
  return withSpokeError(serverId, (client) =>
    client.sendMessage({
      channelId: params.channelId,
      encryptedContent: params.encryptedContent,
      keyVersion: params.keyVersion ?? 0,
      nonce: params.nonce,
      attachmentIds: params.attachmentIds ?? [],
      replyToId: params.replyToId,
      mentionedUserIds: params.mentionedUserIds ?? [],
      mentionedRoleIds: params.mentionedRoleIds ?? [],
      mentionEveryone: params.mentionEveryone ?? false,
    }),
  );
}

export function spokeEditMessage(
  serverId: string,
  params: {
    channelId: string;
    messageId: string;
    encryptedContent: Uint8Array;
    keyVersion?: number;
  },
) {
  return withSpokeError(serverId, (client) =>
    client.editMessage({
      channelId: params.channelId,
      messageId: params.messageId,
      encryptedContent: params.encryptedContent,
      keyVersion: params.keyVersion ?? 0,
    }),
  );
}

export function spokeDeleteMessage(
  serverId: string,
  channelId: string,
  messageId: string,
) {
  return withSpokeError(serverId, (client) =>
    client.deleteMessage({ channelId, messageId }),
  );
}

export function spokeAddReaction(
  serverId: string,
  channelId: string,
  messageId: string,
  emoji: string,
) {
  return withSpokeError(serverId, (client) =>
    client.addReaction({ channelId, messageId, emoji }),
  );
}

export function spokeRemoveReaction(
  serverId: string,
  channelId: string,
  messageId: string,
  emoji: string,
) {
  return withSpokeError(serverId, (client) =>
    client.removeReaction({ channelId, messageId, emoji }),
  );
}

export function spokeAckMessage(
  serverId: string,
  channelId: string,
  messageId: string,
) {
  return withSpokeError(serverId, (client) =>
    client.ackMessage({ channelId, messageId }),
  );
}
