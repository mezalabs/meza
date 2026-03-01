import { createClient } from '@connectrpc/connect';
import { ChatService } from '@meza/gen/meza/v1/chat_pb.ts';
import type { Message } from '@meza/gen/meza/v1/models_pb.ts';
import { transport } from '../api/client.ts';
import { parseMessageContent } from '../crypto/messages.ts';
import { clearAllIndexes, hasIndex, indexMessage } from './local-index.ts';

const chatClient = createClient(ChatService, transport);

/** Channels currently being backfilled (prevents duplicate runs). */
const backfilling = new Set<string>();

/** Channels that have completed a full backfill this session. */
const backfilled = new Set<string>();

/**
 * Try to extract plaintext content from a message for indexing.
 * Returns null if the message is still encrypted.
 *
 * With universal E2EE, all messages arrive encrypted. The gateway decrypts
 * them on arrival and sets keyVersion to 0. Messages with keyVersion > 0
 * are still encrypted and cannot be indexed.
 *
 * Decrypted content may be in V1 JSON format (0x01 prefix) or legacy
 * raw UTF-8. parseMessageContent handles both transparently.
 */
function extractContent(msg: Message): string | null {
  if (!msg.encryptedContent || msg.encryptedContent.length === 0) return null;

  // keyVersion > 0 means the message is still encrypted (not yet decrypted)
  if (msg.keyVersion > 0) return null;
  // keyVersion === 0 means the gateway already decrypted it
  // Parse handles both V1 JSON format and legacy raw UTF-8
  const parsed = parseMessageContent(msg.encryptedContent);
  return parsed.text;
}

/**
 * Index a single message arriving from the gateway in real-time.
 * Safe to call for every incoming message — no-ops if content can't be read.
 */
export function indexIncomingMessage(channelId: string, msg: Message): void {
  const content = extractContent(msg);
  if (!content) return;

  const createdAt = msg.createdAt
    ? Number(msg.createdAt.seconds) * 1000
    : Date.now();

  indexMessage({
    id: msg.id,
    channelId,
    authorId: msg.authorId,
    content,
    createdAt,
  });
}

/**
 * Index a batch of already-fetched messages. Used during backfill to
 * yield to the event loop between chunks. Only indexes already-decrypted
 * messages (keyVersion === 0).
 */
function indexBatch(channelId: string, msgs: Message[]): number {
  let indexed = 0;
  for (const msg of msgs) {
    const content = extractContent(msg);
    if (!content) continue;

    const createdAt = msg.createdAt
      ? Number(msg.createdAt.seconds) * 1000
      : Date.now();

    indexMessage({
      id: msg.id,
      channelId,
      authorId: msg.authorId,
      content,
      createdAt,
    });
    indexed++;
  }
  return indexed;
}

/**
 * Wait for the next idle period (or setTimeout fallback).
 */
function waitIdle(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(() => resolve());
    } else {
      setTimeout(resolve, 16);
    }
  });
}

/**
 * Backfill the FlexSearch index for a channel by fetching historical
 * messages in batches. Runs asynchronously, yielding to the event loop
 * between batches to avoid blocking the UI.
 *
 * With universal E2EE, only already-decrypted messages (keyVersion=0)
 * can be indexed.
 */
export async function backfillChannel(channelId: string): Promise<void> {
  if (backfilling.has(channelId) || backfilled.has(channelId)) return;
  if (hasIndex(channelId)) {
    backfilled.add(channelId);
    return;
  }

  backfilling.add(channelId);

  try {
    const BATCH_SIZE = 100;
    let beforeId: string | undefined;
    let totalIndexed = 0;

    for (let page = 0; page < 10; page++) {
      await waitIdle();

      const res = await chatClient.getMessages({
        channelId,
        before: beforeId ?? '',
        after: '',
        around: '',
        limit: BATCH_SIZE,
      });

      if (res.messages.length === 0) break;

      totalIndexed += indexBatch(channelId, res.messages);

      // Use the oldest message ID as the cursor for the next page
      const oldest = res.messages[res.messages.length - 1];
      if (oldest) beforeId = oldest.id;

      if (!res.hasMore) break;
    }

    if (totalIndexed > 0) backfilled.add(channelId);
  } finally {
    backfilling.delete(channelId);
  }
}

/** Clear all search state (indexes, backfill tracking). Called on logout. */
export function resetSearchState(): void {
  clearAllIndexes();
  backfilling.clear();
  backfilled.clear();
}
