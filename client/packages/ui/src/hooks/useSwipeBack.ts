import type { RefObject } from 'react';
import { useEffect, useRef } from 'react';

const SWIPE_EDGE_WIDTH = 30;
const DISMISS_THRESHOLD = 0.4;
const DIRECTION_LOCK_THRESHOLD = 10;

interface UseSwipeBackOptions {
  /** Offset from the element's left edge before the swipe zone starts (px).
   *  Use to avoid iOS Safari's browser-back gesture on full-screen elements. */
  edgeOffset?: number;
}

/**
 * Detects a right-swipe gesture starting from the left edge of the referenced element.
 * If the swipe exceeds 40% of the element width, calls `onClose`.
 * Uses CSS transform for interactive dragging (GPU accelerated).
 *
 * Includes direction lock: if vertical movement dominates before the lock threshold,
 * the swipe is cancelled to allow normal scrolling.
 *
 * The swipe zone starts at the left edge of the slide-over content (offset 64px
 * from the screen edge by the server rail), avoiding conflict with iOS Safari's
 * browser-back gesture which triggers from the screen's absolute left edge.
 * For full-screen overlays, use `edgeOffset` to skip the browser gesture zone.
 */
export function useSwipeBack(
  ref: RefObject<HTMLElement | null>,
  onClose: () => void,
  options?: UseSwipeBackOptions,
): void {
  const edgeOffset = options?.edgeOffset ?? 0;
  const startXRef = useRef(0);
  const startYRef = useRef(0);
  const trackingRef = useRef(false);
  const directionLockedRef = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    function handleTouchStart(e: TouchEvent) {
      const touch = e.touches[0];
      if (!touch || !el) return;
      const rect = el.getBoundingClientRect();
      const relativeX = touch.clientX - rect.left;
      if (
        relativeX >= edgeOffset &&
        relativeX <= edgeOffset + SWIPE_EDGE_WIDTH
      ) {
        trackingRef.current = true;
        directionLockedRef.current = false;
        startXRef.current = touch.clientX;
        startYRef.current = touch.clientY;
        el.style.transition = 'none';
      }
    }

    function handleTouchMove(e: TouchEvent) {
      if (!trackingRef.current || !el) return;
      const touch = e.touches[0];
      if (!touch) return;
      const dx = touch.clientX - startXRef.current;
      const dy = touch.clientY - startYRef.current;

      // Direction lock: once movement exceeds threshold, decide if this is
      // a horizontal swipe or a vertical scroll. If vertical dominates, abort.
      if (
        !directionLockedRef.current &&
        (Math.abs(dx) > DIRECTION_LOCK_THRESHOLD ||
          Math.abs(dy) > DIRECTION_LOCK_THRESHOLD)
      ) {
        directionLockedRef.current = true;
        if (Math.abs(dy) > Math.abs(dx)) {
          trackingRef.current = false;
          el.style.transition = '';
          el.style.transform = '';
          return;
        }
      }

      el.style.transform = `translateX(${Math.max(0, dx)}px)`;
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
  }, [ref, onClose, edgeOffset]);
}
