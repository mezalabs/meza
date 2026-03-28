import * as ContextMenu from '@radix-ui/react-context-menu';
import type { ReactNode } from 'react';

interface MessageContextMenuProps {
  encryptedContent: Uint8Array;
  isOwn: boolean;
  isPinned: boolean;
  canPin: boolean;
  hasReactions: boolean;
  children: ReactNode;
  onReply: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onPin: () => void;
  onUnpin: () => void;
  onViewProfile?: () => void;
  onViewReactions?: () => void;
}

const decoder = new TextDecoder();

export function MessageContextMenu({
  encryptedContent,
  isOwn,
  isPinned,
  canPin,
  hasReactions,
  children,
  onReply,
  onEdit,
  onDelete,
  onPin,
  onUnpin,
  onViewProfile,
  onViewReactions,
}: MessageContextMenuProps) {
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="min-w-[180px] rounded-lg bg-bg-elevated p-1 shadow-lg animate-scale-in">
          {onViewProfile && (
            <>
              <ContextMenu.Item
                className="cursor-default rounded-md px-3 py-1.5 text-sm text-text outline-none data-[highlighted]:bg-accent-subtle"
                onSelect={onViewProfile}
              >
                View Profile
              </ContextMenu.Item>
              <ContextMenu.Separator className="my-1 h-px bg-border" />
            </>
          )}
          <ContextMenu.Item
            className="cursor-default rounded-md px-3 py-1.5 text-sm text-text outline-none data-[highlighted]:bg-accent-subtle"
            onSelect={onReply}
          >
            Reply
          </ContextMenu.Item>
          {hasReactions && onViewReactions && (
            <ContextMenu.Item
              className="cursor-default rounded-md px-3 py-1.5 text-sm text-text outline-none data-[highlighted]:bg-accent-subtle"
              onSelect={onViewReactions}
            >
              View Reactions
            </ContextMenu.Item>
          )}
          <ContextMenu.Separator className="my-1 h-px bg-border" />
          <ContextMenu.Item
            className="cursor-default rounded-md px-3 py-1.5 text-sm text-text outline-none data-[highlighted]:bg-accent-subtle"
            onSelect={() => {
              const text = decoder.decode(encryptedContent);
              navigator.clipboard.writeText(text);
            }}
          >
            Copy Text
          </ContextMenu.Item>
          {canPin && (
            <>
              <ContextMenu.Separator className="my-1 h-px bg-border" />
              <ContextMenu.Item
                className="cursor-default rounded-md px-3 py-1.5 text-sm text-text outline-none data-[highlighted]:bg-accent-subtle"
                onSelect={isPinned ? onUnpin : onPin}
              >
                {isPinned ? 'Unpin Message' : 'Pin Message'}
              </ContextMenu.Item>
            </>
          )}
          {isOwn && (
            <>
              <ContextMenu.Separator className="my-1 h-px bg-border" />
              <ContextMenu.Item
                className="cursor-default rounded-md px-3 py-1.5 text-sm text-text outline-none data-[highlighted]:bg-accent-subtle"
                onSelect={onEdit}
              >
                Edit Message
              </ContextMenu.Item>
              <ContextMenu.Item
                className="cursor-default rounded-md px-3 py-1.5 text-sm text-error outline-none data-[highlighted]:bg-error/10"
                onSelect={onDelete}
              >
                Delete Message
              </ContextMenu.Item>
            </>
          )}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
