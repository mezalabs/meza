import * as Popover from '@radix-ui/react-popover';
import { memo, useState } from 'react';
import { TwemojiImg } from '../shared/TwemojiImg.tsx';

const SKIN_TONES = [
  { label: 'Default', emoji: '👋' },
  { label: 'Light', emoji: '👋🏻' },
  { label: 'Medium-Light', emoji: '👋🏼' },
  { label: 'Medium', emoji: '👋🏽' },
  { label: 'Medium-Dark', emoji: '👋🏾' },
  { label: 'Dark', emoji: '👋🏿' },
];

interface EmojiPickerSkinToneProps {
  value: number;
  onChange: (tone: number) => void;
}

export const EmojiPickerSkinTone = memo(function EmojiPickerSkinTone({
  value,
  onChange,
}: EmojiPickerSkinToneProps) {
  const [open, setOpen] = useState(false);
  const current = SKIN_TONES[value] ?? SKIN_TONES[0];

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={`Skin tone: ${current.label}`}
          title="Change skin tone"
          className="flex items-center justify-center w-8 h-8 mb-1 rounded-md hover:bg-bg-surface transition-colors"
        >
          <TwemojiImg emoji={current.emoji} size={22} />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="z-[100] flex gap-0.5 rounded-lg border border-border bg-bg-elevated p-1 shadow-lg data-[state=open]:animate-scale-in data-[state=closed]:animate-scale-out"
          side="bottom"
          align="end"
          sideOffset={4}
        >
          {SKIN_TONES.map((tone, index) => (
            <button
              key={tone.label}
              type="button"
              aria-label={`Skin tone: ${tone.label}`}
              className={`flex items-center justify-center w-8 h-8 rounded-md transition-colors ${
                index === value
                  ? 'bg-accent/20 ring-1 ring-accent'
                  : 'hover:bg-bg-surface'
              }`}
              onClick={() => {
                onChange(index);
                setOpen(false);
              }}
            >
              <TwemojiImg emoji={tone.emoji} size={22} />
            </button>
          ))}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
});
