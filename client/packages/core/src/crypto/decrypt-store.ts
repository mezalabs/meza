/**
 * Shared decrypt-and-update-store helper.
 *
 * Three paths may call this concurrently:
 *   1. Gateway real-time   (gateway.ts  decryptInBackground)
 *   2. ChannelView fetch   (ChannelView.tsx  getMessages .then)
 *   3. ChannelView deferred-keys  (ChannelView.tsx  keysAvailable effect)
 *
 * The keyVersion > 0 check acts as an idempotency guard so only the
 * first path to finish actually writes the decrypted content.
 */

import type { Attachment, Message } from '@meza/gen/meza/v1/models_pb.ts';
import {
  indexIncomingMessage,
  indexIncomingMessages,
} from '../search/indexer.ts';
import { useMessageStore } from '../store/messages.ts';
import { decryptMessage, parseMessageContent } from './messages.ts';

/**
 * Decrypt an encrypted message and update the message store in place.
 *
 * ## Dual-decrypt path synchronization
 *
 * Three independent code paths may call this function for the same message
 * concurrently:
 *
 *   1. **Gateway real-time** -- `decryptInBackground` in `gateway.ts` fires
 *      as each encrypted message arrives over the WebSocket.
 *   2. **ChannelView fetch-time** -- after `getMessages` resolves, the
 *      component decrypts the batch of historical messages it just fetched.
 *   3. **ChannelView deferred-keys effect** -- the `keysAvailable` effect in
 *      `ChannelView.tsx` re-scans all still-encrypted messages once the
 *      channel key becomes available (e.g. after key distribution completes).
 *
 * Because these paths are independent and may overlap, idempotency is
 * critical. The guard works as follows:
 *
 *   - After decryption, the function re-reads the message from the store.
 *   - If `stored.keyVersion === 0`, another path already wrote the plaintext,
 *     so the function returns `false` without a second write.
 *   - If the message is no longer in the store at all, it also returns
 *     `false`.
 *
 * This means concurrent decryption from multiple paths is safe but may
 * occasionally waste CPU performing a redundant decrypt operation whose
 * result is discarded. This is an acceptable trade-off for keeping the
 * paths decoupled and lock-free.
 *
 * @param channelId      - Channel the message belongs to
 * @param msg            - The encrypted message (must have keyVersion > 0)
 * @param senderPublicKey - Ed25519 public key of the message author
 * @returns `true` if decryption succeeded and the store was updated
 */
export async function decryptAndUpdateMessage(
  channelId: string,
  msg: Pick<
    Message,
    'id' | 'authorId' | 'keyVersion' | 'encryptedContent' | 'attachments'
  >,
  senderPublicKey: Uint8Array,
): Promise<boolean> {
  const result = await decryptMessageInPlace(channelId, msg, senderPublicKey);
  if (!result) return false;

  useMessageStore.getState().updateMessage(channelId, result);
  // Index the now-decrypted message for local search
  indexIncomingMessage(channelId, result);
  return true;
}

/**
 * Decrypt a batch of messages and apply all results in a single store write.
 * Eliminates per-message re-renders that cause visible bottom-to-top decryption.
 */
export async function decryptAndUpdateMessages(
  channelId: string,
  msgs: Array<
    Pick<
      Message,
      'id' | 'authorId' | 'keyVersion' | 'encryptedContent' | 'attachments'
    >
  >,
  pubKeys: Record<string, Uint8Array>,
): Promise<number> {
  const results: Message[] = [];
  for (const msg of msgs) {
    const pk = pubKeys[msg.authorId];
    if (!pk) continue;
    try {
      const result = await decryptMessageInPlace(channelId, msg, pk);
      if (result) results.push(result);
    } catch (err) {
      console.error(`[E2EE] batch decrypt failed for ${msg.id}:`, err);
    }
  }
  if (results.length > 0) {
    useMessageStore.getState().bulkUpdateMessages(channelId, results);
    // Index the now-decrypted messages for local search (batched)
    indexIncomingMessages(channelId, results);
  }
  return results.length;
}

/**
 * Decrypt a message and return the updated Message object without writing
 * to the store. Returns null if the message was already decrypted or missing.
 */
async function decryptMessageInPlace(
  channelId: string,
  msg: Pick<
    Message,
    'id' | 'authorId' | 'keyVersion' | 'encryptedContent' | 'attachments'
  >,
  senderPublicKey: Uint8Array,
): Promise<Message | null> {
  const plaintext = await decryptMessage(
    channelId,
    msg.keyVersion,
    msg.encryptedContent,
    senderPublicKey,
  );

  const parsed = parseMessageContent(plaintext);

  // Re-read from store -- another concurrent path may have already decrypted.
  const stored = useMessageStore.getState().byId[channelId]?.[msg.id];
  if (!stored || stored.keyVersion === 0) return null;

  // Enrich attachments with metadata from the encrypted JSON payload
  let enrichedAttachments: Attachment[] = stored.attachments;
  if (parsed.attachmentMeta && stored.attachments.length > 0) {
    enrichedAttachments = stored.attachments.map((att) => {
      const meta = parsed.attachmentMeta?.[att.id];
      if (!meta) return att;
      return {
        ...att,
        filename: meta.fn || att.filename,
        contentType: meta.ct || att.contentType,
      };
    });
  }

  const textBytes = new TextEncoder().encode(parsed.text);
  return {
    ...stored,
    encryptedContent: textBytes,
    keyVersion: 0,
    attachments: enrichedAttachments,
  };
}
