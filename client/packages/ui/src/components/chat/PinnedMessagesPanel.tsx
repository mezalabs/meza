import {
  getPinnedMessages,
  unpinMessage,
  useMessageStore,
  usePinStore,
} from '@meza/core';
import { XIcon } from '@phosphor-icons/react';
import { useEffect } from 'react';
import { resolveDisplayName } from '../../hooks/useDisplayName.ts';
import { stripMarkdown } from '../shared/stripMarkdown.ts';

interface PinnedMessagesPanelProps {
  channelId: string;
  serverId?: string;
  canUnpin: boolean;
  onClose: () => void;
  onJumpToMessage: (messageId: string) => void;
}

const decoder = new TextDecoder();
const EMPTY_PINS: never[] = [];

export function PinnedMessagesPanel({
  channelId,
  serverId,
  canUnpin,
  onClose,
  onJumpToMessage,
}: PinnedMessagesPanelProps) {
  const pins = usePinStore((s) => s.byChannel[channelId] ?? EMPTY_PINS);
  const hasMore = usePinStore((s) => !!s.hasMore[channelId]);
  const isLoading = usePinStore((s) => !!s.isLoading[channelId]);
  // Subscribe to the decrypted messages in the message store so we can
  // display plaintext instead of encrypted bytes.
  const messageById = useMessageStore((s) => s.byId[channelId]);

  useEffect(() => {
    getPinnedMessages(channelId);
  }, [channelId]);

  const loadMore = () => {
    const last = pins[pins.length - 1];
    if (last?.pinnedAt) {
      const cursor = new Date(
        Number(last.pinnedAt.seconds) * 1000,
      ).toISOString();
      getPinnedMessages(channelId, cursor);
    }
  };

  return (
    <div className="w-64 flex-shrink-0 border-l border-border bg-bg-surface overflow-y-auto">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <h3 className="text-xs font-medium text-text">Pinned Messages</h3>
        <button
          type="button"
          className="p-0.5 text-text-muted hover:text-text rounded"
          onClick={onClose}
          aria-label="Close pinned messages"
        >
          <XIcon weight="regular" size={12} aria-hidden="true" />
        </button>
      </div>

      {isLoading && pins.length === 0 && (
        <div className="px-3 py-8 text-xs text-text-muted text-center">
          Loading...
        </div>
      )}

      {!isLoading && pins.length === 0 && (
        <div className="px-3 py-8 text-xs text-text-muted text-center">
          No pinned messages
        </div>
      )}

      {pins.map((pin) => {
        const msg = pin.message;
        if (!msg) return null;
        // Prefer the decrypted version from the message store (keyVersion === 0
        // means already decrypted). Fall back to the pin's own message data.
        const decrypted = messageById?.[msg.id];
        const content =
          decrypted && decrypted.keyVersion === 0
            ? decrypted.encryptedContent
            : msg.keyVersion === 0
              ? msg.encryptedContent
              : null;
        const text = content
          ? stripMarkdown(decoder.decode(content))
          : '[Encrypted message]';
        const time = msg.createdAt
          ? new Date(Number(msg.createdAt.seconds) * 1000)
          : null;
        return (
          <div
            key={msg.id}
            className="border-b border-border hover:bg-bg-elevated/50 transition-colors"
          >
            <button
              type="button"
              className="w-full text-left px-3 py-2 cursor-pointer"
              onClick={() => onJumpToMessage(msg.id)}
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-xs font-medium text-text">
                  {resolveDisplayName(msg.authorId, serverId)}
                </span>
                {time && (
                  <span className="text-[10px] text-text-subtle">
                    {time.toLocaleDateString()}
                  </span>
                )}
              </div>
              <p className="text-xs text-text mt-1 break-words line-clamp-3">
                {text}
              </p>
            </button>
            {canUnpin && (
              <button
                type="button"
                className="px-3 pb-2 text-[10px] text-text-muted hover:text-text"
                onClick={(e) => {
                  e.stopPropagation();
                  unpinMessage(msg.channelId, msg.id);
                }}
              >
                Unpin
              </button>
            )}
          </div>
        );
      })}

      {hasMore && (
        <button
          type="button"
          className="w-full px-3 py-2 text-xs text-accent hover:text-accent-emphasis text-center"
          onClick={loadMore}
          disabled={isLoading}
        >
          {isLoading ? 'Loading...' : 'Load more'}
        </button>
      )}
    </div>
  );
}
