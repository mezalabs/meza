import { ArrowLeftIcon } from '@phosphor-icons/react';
import { useCallback, useRef } from 'react';
import { useSwipeBack } from '../../hooks/useSwipeBack.ts';

interface MobileOverlayProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}

/**
 * Generic full-screen overlay for mobile secondary panels.
 * Covers the entire viewport (including server rail).
 * Used for member list, pinned messages, search, and settings.
 *
 * Always rendered in the DOM with CSS transforms for slide animation
 * and swipe-back gesture support (matching MobileSlideOver pattern).
 */
export function MobileOverlay({
  open,
  onClose,
  title,
  children,
}: MobileOverlayProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const stableOnClose = useCallback(() => onClose(), [onClose]);
  useSwipeBack(containerRef, stableOnClose, { edgeOffset: 20 });

  return (
    <div
      ref={containerRef}
      className={`fixed inset-0 z-50 flex flex-col bg-bg-base safe-top safe-bottom transition-transform duration-300 ease-snappy will-change-transform ${
        open ? 'translate-x-0' : 'translate-x-full pointer-events-none'
      }`}
    >
      <header className="flex h-12 flex-shrink-0 items-center gap-2 border-b border-border/40 px-2">
        <button
          type="button"
          onClick={onClose}
          className="p-2 text-text-muted hover:text-text transition-colors"
          aria-label="Back"
        >
          <ArrowLeftIcon size={20} aria-hidden="true" />
        </button>
        <h2 className="flex-1 truncate text-base font-semibold text-text">
          {title}
        </h2>
      </header>
      <div className="flex-1 min-h-0 overflow-y-auto">{children}</div>
    </div>
  );
}
