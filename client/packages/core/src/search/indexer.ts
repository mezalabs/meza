import { createClient } from '@connectrpc/connect';
import { ChatService } from '@meza/gen/meza/v1/chat_pb.ts';
import type { Message } from '@meza/gen/meza/v1/models_pb.ts';
import { transport } from '../api/client.ts';
import { parseMessageContent } from '../crypto/messages.ts';
import {
  addSearchMessages,
  clearAllSearchIndexes,
  initSearchChannel,
  terminateSearchWorker,
} from './search-service.ts';
import type { IndexableMessage } from './types.ts';

const chatClient = createClient(ChatService, transport);

/** Channels currently being backfilled (prevents duplicate runs). */
const backfilling = new Set<string>();

/** Channels that have completed a full backfill this session. */
const backfilled = new Set<string>();

/**
 * Convert a decrypted Message to an IndexableMessage.
 * Returns null if the message is still encrypted (keyVersion > 0).
 */
export function toIndexable(
  channelId: string,
  msg: Message,
): IndexableMessage | null {
  if (!msg.encryptedContent || msg.encryptedContent.length === 0) return null;
  if (msg.keyVersion > 0) return null;

  const parsed = parseMessageContent(msg.encryptedContent);
  if (!parsed.text) return null;

  return {
    id: msg.id,
    channelId,
    authorId: msg.authorId,
    content: parsed.text,
    createdAt: msg.createdAt
      ? Number(msg.createdAt.seconds) * 1000
      : Date.now(),
    hasAttachment: (msg.attachments?.length ?? 0) > 0,
    hasMention: (msg.mentionedUserIds?.length ?? 0) > 0 || !!msg.mentionEveryone,
  };
}

/**
 * Index a single message arriving from the gateway in real-time.
 * Safe to call for every incoming message — no-ops if content can't be read.
 */
export function indexIncomingMessage(channelId: string, msg: Message): void {
  const indexable = toIndexable(channelId, msg);
  if (!indexable) return;
  try {
    addSearchMessages(channelId, [indexable]).catch(() => {});
  } catch {
    // Worker not available (test/SSR environment)
  }
}

/**
 * Convert a batch of messages to IndexableMessage[].
 */
function toBatch(channelId: string, msgs: Message[]): IndexableMessage[] {
  const batch: IndexableMessage[] = [];
  for (const msg of msgs) {
    const indexable = toIndexable(channelId, msg);
    if (indexable) batch.push(indexable);
  }
  return batch;
}

/**
 * Backfill the FlexSearch index for a channel by fetching historical
 * messages in batches. The worker handles yielding internally.
 *
 * Progressive backfill:
 * - Phase A: 10 pages (1,000 msgs) — user gets search results in ~1-2s
 * - Phase B: 20 more pages (2,000 msgs) — runs in background
 */
export async function backfillChannel(channelId: string): Promise<void> {
  if (backfilling.has(channelId) || backfilled.has(channelId)) return;

  backfilling.add(channelId);

  try {
    // Init the channel index (loads from IndexedDB if persisted)
    await initSearchChannel(channelId);

    const BATCH_SIZE = 100;
    const PHASE_A_PAGES = 10;
    const PHASE_B_PAGES = 20;
    const TOTAL_PAGES = PHASE_A_PAGES + PHASE_B_PAGES;
    let beforeId: string | undefined;
    let totalIndexed = 0;

    for (let page = 0; page < TOTAL_PAGES; page++) {
      const res = await chatClient.getMessages({
        channelId,
        before: beforeId ?? '',
        after: '',
        around: '',
        limit: BATCH_SIZE,
      });

      if (res.messages.length === 0) break;

      const batch = toBatch(channelId, res.messages);
      if (batch.length > 0) {
        totalIndexed += await addSearchMessages(channelId, batch);
      }

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
export async function resetSearchState(): Promise<void> {
  try {
    await clearAllSearchIndexes();
  } catch {
    // Worker not available (test/SSR environment)
  }
  terminateSearchWorker();
  backfilling.clear();
  backfilled.clear();
}
