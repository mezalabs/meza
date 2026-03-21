import { MagnifyingGlassIcon } from '@phosphor-icons/react';
import { memo, useEffect, useRef } from 'react';

interface EmojiPickerSearchProps {
  value: string;
  onChange: (value: string) => void;
  autoFocus?: boolean;
  /** Called when the search input gains or loses focus (for mobile panel mode). */
  onFocusChange?: (focused: boolean) => void;
}

export const EmojiPickerSearch = memo(function EmojiPickerSearch({
  value,
  onChange,
  autoFocus = true,
  onFocusChange,
}: EmojiPickerSearchProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (autoFocus) {
      // Delay slightly so the popover is fully rendered
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [autoFocus]);

  return (
    <div className="relative px-2 pt-2 pb-1">
      <MagnifyingGlassIcon
        size={16}
        className="absolute left-4 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none"
        aria-hidden="true"
      />
      <input
        ref={inputRef}
        type="search"
        aria-label="Search emojis"
        placeholder="Search emojis…"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => onFocusChange?.(true)}
        onBlur={() => onFocusChange?.(false)}
        className="w-full rounded-md bg-bg-base px-3 py-1.5 pl-8 text-sm text-text placeholder:text-text-muted outline-none focus:ring-1 focus:ring-accent border border-border"
      />
    </div>
  );
});
