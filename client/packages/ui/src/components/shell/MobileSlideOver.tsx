import { useCallback, useRef } from 'react';
import { useSwipeBack } from '../../hooks/useSwipeBack.ts';

interface MobileSlideOverProps {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
}

/**
 * Animated slide-over container for mobile navigation.
 * Slides content in from the right using CSS transforms (GPU accelerated).
 * Supports swipe-from-left-edge gesture to dismiss.
 */
export function MobileSlideOver({
  open,
  onClose,
  children,
}: MobileSlideOverProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const stableOnClose = useCallback(() => onClose(), [onClose]);
  useSwipeBack(containerRef, stableOnClose);

  return (
    <div
      ref={containerRef}
      className={`absolute inset-0 z-20 flex flex-col bg-bg-base transition-transform duration-300 ease-snappy will-change-transform ${
        open ? 'translate-x-0' : 'translate-x-full'
      }`}
    >
      {children}
    </div>
  );
}
