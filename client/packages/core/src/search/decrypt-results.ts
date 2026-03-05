import type { Message } from '@meza/gen/meza/v1/models_pb.ts';
import { getPublicKeys } from '../api/keys.ts';
import { decryptMessage, parseMessageContent } from '../crypto/messages.ts';

export interface DecryptedSearchResult {
  readonly message: Message;
  readonly decryptedContent: string | null;
}

/**
 * Decrypt server search results for display in the search pane.
 * Messages with keyVersion=0 are already decrypted (parse content directly).
 * Messages with keyVersion>0 need full decryption via the crypto module.
 */
export async function decryptSearchResults(
  messages: Message[],
): Promise<DecryptedSearchResult[]> {
  // Collect unique author IDs for public key fetch
  const authorIds = [
    ...new Set(
      messages
        .filter((m) => m.keyVersion > 0 && m.encryptedContent?.length)
        .map((m) => m.authorId),
    ),
  ];

  // Batch-fetch sender public keys
  let pubKeys: Record<string, Uint8Array> = {};
  if (authorIds.length > 0) {
    try {
      pubKeys = await getPublicKeys(authorIds);
    } catch {
      // Continue — encrypted messages will show as undecryptable
    }
  }

  return Promise.all(
    messages.map(async (msg): Promise<DecryptedSearchResult> => {
      // Already decrypted or empty
      if (!msg.encryptedContent?.length || msg.keyVersion === 0) {
        const content = msg.encryptedContent?.length
          ? parseMessageContent(msg.encryptedContent).text
          : null;
        return { message: msg, decryptedContent: content };
      }

      // Needs decryption
      const senderKey = pubKeys[msg.authorId];
      if (!senderKey) {
        return { message: msg, decryptedContent: null };
      }

      try {
        const decrypted = await decryptMessage(
          msg.channelId,
          msg.keyVersion,
          msg.encryptedContent,
          senderKey,
        );
        const parsed = parseMessageContent(decrypted);
        return { message: msg, decryptedContent: parsed.text };
      } catch {
        return { message: msg, decryptedContent: null };
      }
    }),
  );
}
