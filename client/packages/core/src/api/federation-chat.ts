/**
 * Spoke-specific wrappers for core write operations.
 *
 * These mirror the origin API functions in chat.ts but route through
 * the spoke transport. The caller determines if the server is federated
 * and uses the spoke variant.
 */
import { createClient } from '@connectrpc/connect';
import { ChatService } from '@meza/gen/meza/v1/chat_pb.ts';
import { useFederationStore } from '../store/federation.ts';
import { mapFederationError } from './federation.ts';
import { getSpokeTransport } from './federation-transport.ts';

function getSpokeChat(serverId: string) {
  const instanceUrl = useFederationStore.getState().serverIndex[serverId];
  if (!instanceUrl) throw new Error('Not a federated server');
  return createClient(ChatService, getSpokeTransport(instanceUrl));
}

export async function spokeSendMessage(
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
  try {
    const client = getSpokeChat(serverId);
    return await client.sendMessage({
      channelId: params.channelId,
      encryptedContent: params.encryptedContent,
      keyVersion: params.keyVersion ?? 0,
      nonce: params.nonce,
      attachmentIds: params.attachmentIds ?? [],
      replyToId: params.replyToId,
      mentionedUserIds: params.mentionedUserIds ?? [],
      mentionedRoleIds: params.mentionedRoleIds ?? [],
      mentionEveryone: params.mentionEveryone ?? false,
    });
  } catch (err) {
    throw new Error(mapFederationError(err), { cause: err });
  }
}

export async function spokeEditMessage(
  serverId: string,
  params: {
    channelId: string;
    messageId: string;
    encryptedContent: Uint8Array;
    keyVersion?: number;
  },
) {
  try {
    const client = getSpokeChat(serverId);
    return await client.editMessage({
      channelId: params.channelId,
      messageId: params.messageId,
      encryptedContent: params.encryptedContent,
      keyVersion: params.keyVersion ?? 0,
    });
  } catch (err) {
    throw new Error(mapFederationError(err), { cause: err });
  }
}

export async function spokeDeleteMessage(
  serverId: string,
  channelId: string,
  messageId: string,
) {
  try {
    const client = getSpokeChat(serverId);
    await client.deleteMessage({ channelId, messageId });
  } catch (err) {
    throw new Error(mapFederationError(err), { cause: err });
  }
}

export async function spokeAddReaction(
  serverId: string,
  channelId: string,
  messageId: string,
  emoji: string,
) {
  try {
    const client = getSpokeChat(serverId);
    await client.addReaction({ channelId, messageId, emoji });
  } catch (err) {
    throw new Error(mapFederationError(err), { cause: err });
  }
}

export async function spokeRemoveReaction(
  serverId: string,
  channelId: string,
  messageId: string,
  emoji: string,
) {
  try {
    const client = getSpokeChat(serverId);
    await client.removeReaction({ channelId, messageId, emoji });
  } catch (err) {
    throw new Error(mapFederationError(err), { cause: err });
  }
}

export async function spokeAckMessage(
  serverId: string,
  channelId: string,
  messageId: string,
) {
  try {
    const client = getSpokeChat(serverId);
    await client.ackMessage({ channelId, messageId });
  } catch (err) {
    throw new Error(mapFederationError(err), { cause: err });
  }
}
