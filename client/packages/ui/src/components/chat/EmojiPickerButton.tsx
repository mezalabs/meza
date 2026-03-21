import { SmileyIcon } from '@phosphor-icons/react';
import * as Popover from '@radix-ui/react-popover';
import { memo, useState } from 'react';
import { useMobile } from '../../hooks/useMobile.ts';
import { EmojiPicker } from './EmojiPicker.tsx';

interface EmojiPickerButtonProps {
  onSelect: (text: string) => void;
  onClose?: () => void;
  disabled?: boolean;
  serverId?: string;
  /** Mobile-only: whether the emoji panel is currently open. */
  mobileEmojiOpen?: boolean;
  /** Mobile-only: toggle the emoji panel instead of opening a popover. */
  onMobileToggle?: () => void;
}

export const EmojiPickerButton = memo(function EmojiPickerButton({
  onSelect,
  onClose,
  disabled,
  serverId,
  mobileEmojiOpen,
  onMobileToggle,
}: EmojiPickerButtonProps) {
  const isMobile = useMobile();
  const [open, setOpen] = useState(false);

  // On mobile, just render a toggle button — the panel is rendered by ChannelView
  if (isMobile) {
    return (
      <button
        type="button"
        aria-label="Insert emoji"
        className={`flex-shrink-0 self-start mt-5 mr-5 transition-colors disabled:opacity-50 ${
          mobileEmojiOpen
            ? 'text-accent'
            : 'text-text-muted hover:text-text'
        }`}
        disabled={disabled}
        onClick={onMobileToggle}
      >
        <SmileyIcon size={22} aria-hidden="true" />
      </button>
    );
  }

  // Desktop: Radix Popover (unchanged)
  return (
    <Popover.Root
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) onClose?.();
      }}
    >
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label="Insert emoji"
          className="flex-shrink-0 self-start mt-5 mr-5 text-text-muted transition-colors hover:text-text disabled:opacity-50 data-[state=open]:text-accent"
          disabled={disabled}
        >
          <SmileyIcon size={22} aria-hidden="true" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="z-50 rounded-xl border border-border shadow-lg data-[state=open]:animate-scale-in data-[state=closed]:animate-scale-out"
          side="top"
          align="end"
          sideOffset={8}
          collisionPadding={16}
        >
          <EmojiPicker onEmojiSelect={onSelect} serverId={serverId} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
});
