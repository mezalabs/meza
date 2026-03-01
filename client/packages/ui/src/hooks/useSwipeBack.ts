import type { RefObject } from 'react';
import { useEffect, useRef } from 'react';

const SWIPE_EDGE_WIDTH = 30;
const DISMISS_THRESHOLD = 0.4;

/**
 * Detects a right-swipe gesture starting from the left edge of the referenced element.
 * If the swipe exceeds 40% of the element width, calls `onClose`.
 * Uses CSS transform for interactive dragging (GPU accelerated).
 *
 * The swipe zone starts at the left edge of the slide-over content (offset 64px
 * from the screen edge by the server rail), avoiding conflict with iOS Safari's
 * browser-back gesture which triggers from the screen's absolute left edge.
 */
export function useSwipeBack(
  ref: RefObject<HTMLElement | null>,
  onClose: () => void,
): void {
  const startXRef = useRef(0);
  const trackingRef = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    function handleTouchStart(e: TouchEvent) {
      const touch = e.touches[0];
      if (!touch || !el) return;
      const rect = el.getBoundingClientRect();
      const relativeX = touch.clientX - rect.left;
      if (relativeX <= SWIPE_EDGE_WIDTH) {
        trackingRef.current = true;
        startXRef.current = touch.clientX;
        el.style.transition = 'none';
      }
    }

    function handleTouchMove(e: TouchEvent) {
      if (!trackingRef.current || !el) return;
      const touch = e.touches[0];
      if (!touch) return;
      const dx = Math.max(0, touch.clientX - startXRef.current);
      el.style.transform = `translateX(${dx}px)`;
    }

    function handleTouchEnd(e: TouchEvent) {
      if (!trackingRef.current || !el) return;
      trackingRef.current = false;
      const touch = e.changedTouches[0];
      if (!touch) {
        el.style.transition = '';
        el.style.transform = '';
        return;
      }
      const dx = touch.clientX - startXRef.current;
      const width = el.getBoundingClientRect().width;
      el.style.transition = '';
      if (dx / width > DISMISS_THRESHOLD) {
        el.style.transform = `translateX(${width}px)`;
        // Wait for transition to complete before calling onClose
        const handler = () => {
          el.removeEventListener('transitionend', handler);
          el.style.transform = '';
          onClose();
        };
        el.addEventListener('transitionend', handler);
      } else {
        el.style.transform = '';
      }
    }

    el.addEventListener('touchstart', handleTouchStart, { passive: true });
    el.addEventListener('touchmove', handleTouchMove, { passive: true });
    el.addEventListener('touchend', handleTouchEnd, { passive: true });

    return () => {
      el.removeEventListener('touchstart', handleTouchStart);
      el.removeEventListener('touchmove', handleTouchMove);
      el.removeEventListener('touchend', handleTouchEnd);
    };
  }, [ref, onClose]);
}
