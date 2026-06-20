import {
  addReaction,
  safeParseMessageText,
  useAuthStore,
  useReactionStore,
} from '@meza/core';
import { CopyIcon, DotsThreeIcon, PlusIcon } from '@phosphor-icons/react';
import { memo, useCallback, useEffect, useRef } from 'react';
import { TwemojiImg } from '../shared/TwemojiImg.tsx';

const QUICK_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

interface QuickReactionBarProps {
  messageId: string;
  channelId: string;
  encryptedContent: Uint8Array;
  anchorRect: DOMRect;
  onClose: () => void;
  onOpenContextMenu: () => void;
  onOpenFullPicker: () => void;
}

export const QuickReactionBar = memo(function QuickReactionBar({
  messageId,
  channelId,
  encryptedContent,
  anchorRect,
  onClose,
  onOpenContextMenu,
  onOpenFullPicker,
}: QuickReactionBarProps) {
  const barRef = useRef<HTMLDivElement>(null);

  const handleReaction = useCallback(
    (emoji: string) => {
      const userId = useAuthStore.getState().user?.id;
      if (!userId) return;
      useReactionStore.getState().addReaction(messageId, emoji, userId, true);
      addReaction(channelId, messageId, emoji).catch(() => {
        useReactionStore
          .getState()
          .removeReaction(messageId, emoji, userId, true);
      });
      onClose();
    },
    [channelId, messageId, onClose],
  );

  const handleCopy = useCallback(() => {
    navigator.clipboard
      .writeText(safeParseMessageText(encryptedContent))
      .catch(() => {});
    onClose();
  }, [encryptedContent, onClose]);

  // Dismiss on outside tap
  useEffect(() => {
    function handleTouch(e: TouchEvent) {
      if (barRef.current && !barRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    // Use a rAF to avoid the same touch that opened the bar from closing it
    const raf = requestAnimationFrame(() => {
      document.addEventListener('touchstart', handleTouch, { passive: true });
    });
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('touchstart', handleTouch);
    };
  }, [onClose]);

  // Position above the message, centered horizontally, clamped to viewport
  const barWidth = 360; // approximate width
  const gap = 8;
  let top = anchorRect.top - 44 - gap;
  let left = anchorRect.left + anchorRect.width / 2 - barWidth / 2;

  // Clamp to viewport
  if (left < 8) left = 8;
  if (left + barWidth > window.innerWidth - 8)
    left = window.innerWidth - barWidth - 8;
  // If not enough space above, show below
  if (top < 8) top = anchorRect.bottom + gap;

  return (
    <>
      {/* Dimmed backdrop */}
      <div
        className="fixed inset-0 z-[60] bg-black/20"
        onTouchStart={(e) => {
          e.stopPropagation();
          onClose();
        }}
      />
      {/* Reaction bar */}
      <div
        ref={barRef}
        className="fixed z-[61] flex items-center gap-1 rounded-full bg-bg-elevated border border-border px-2 py-1.5 shadow-lg animate-scale-in"
        style={{ top, left }}
      >
        {QUICK_EMOJIS.map((emoji) => (
          <button
            key={emoji}
            type="button"
            className="flex h-8 w-8 items-center justify-center rounded-full hover:bg-bg-surface active:scale-90 transition-transform"
            onClick={() => handleReaction(emoji)}
          >
            <TwemojiImg emoji={emoji} size={22} />
          </button>
        ))}
        <div className="mx-0.5 h-5 w-px bg-border" />
        <button
          type="button"
          className="flex h-8 w-8 items-center justify-center rounded-full text-text-muted hover:bg-bg-surface hover:text-text"
          onClick={() => {
            onClose();
            onOpenFullPicker();
          }}
          title="More emojis"
        >
          <PlusIcon size={16} weight="bold" />
        </button>
        <button
          type="button"
          className="flex h-8 w-8 items-center justify-center rounded-full text-text-muted hover:bg-bg-surface hover:text-text"
          onClick={handleCopy}
          title="Copy text"
        >
          <CopyIcon size={16} weight="bold" />
        </button>
        <button
          type="button"
          className="flex h-8 w-8 items-center justify-center rounded-full text-text-muted hover:bg-bg-surface hover:text-text"
          onClick={() => {
            onClose();
            onOpenContextMenu();
          }}
          title="More actions"
        >
          <DotsThreeIcon size={18} weight="bold" />
        </button>
      </div>
    </>
  );
});
