import { memo, useEffect } from 'react';

interface MobileMessageActionsProps {
  isOwn: boolean;
  isPinned: boolean;
  canPin: boolean;
  canManageMessages: boolean;
  hasReactions: boolean;
  encryptedContent: Uint8Array;
  onClose: () => void;
  onReply: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onPin: () => void;
  onUnpin: () => void;
  onViewProfile?: () => void;
  onViewReactions?: () => void;
}

const decoder = new TextDecoder();

/**
 * Mobile bottom sheet for message context actions.
 * Triggered from the "..." button on the QuickReactionBar.
 */
export const MobileMessageActions = memo(function MobileMessageActions({
  isOwn,
  isPinned,
  canPin,
  canManageMessages,
  hasReactions,
  encryptedContent,
  onClose,
  onReply,
  onEdit,
  onDelete,
  onPin,
  onUnpin,
  onViewProfile,
  onViewReactions,
}: MobileMessageActionsProps) {
  // Dismiss on outside tap
  useEffect(() => {
    function handleTouch(e: TouchEvent) {
      const sheet = document.getElementById('mobile-message-actions');
      if (sheet && !sheet.contains(e.target as Node)) {
        onClose();
      }
    }
    const raf = requestAnimationFrame(() => {
      document.addEventListener('touchstart', handleTouch, { passive: true });
    });
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('touchstart', handleTouch);
    };
  }, [onClose]);

  function action(label: string, handler: () => void, destructive?: boolean) {
    return (
      <button
        type="button"
        className={`w-full px-4 py-3 text-left text-sm transition-colors active:bg-bg-surface ${
          destructive ? 'text-error' : 'text-text'
        }`}
        onClick={() => {
          handler();
          onClose();
        }}
      >
        {label}
      </button>
    );
  }

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-[60] bg-black/30"
        onTouchStart={(e) => {
          e.stopPropagation();
          onClose();
        }}
      />
      {/* Bottom sheet */}
      <div
        id="mobile-message-actions"
        className="fixed bottom-0 left-0 right-0 z-[61] rounded-t-2xl bg-bg-elevated border-t border-border safe-bottom animate-slide-up"
      >
        <div className="mx-auto mt-2 mb-1 h-1 w-8 rounded-full bg-border" />
        <div className="flex flex-col py-1">
          {onViewProfile && action('View Profile', onViewProfile)}
          {action('Reply', onReply)}
          {hasReactions &&
            onViewReactions &&
            action('View Reactions', onViewReactions)}
          {action('Copy Text', () => {
            const text = decoder.decode(encryptedContent);
            navigator.clipboard.writeText(text);
          })}
          {canPin &&
            (isPinned
              ? action('Unpin Message', onUnpin)
              : action('Pin Message', onPin))}
          {isOwn && action('Edit Message', onEdit)}
          {(isOwn || canManageMessages) &&
            action('Delete Message', onDelete, true)}
        </div>
      </div>
    </>
  );
});
