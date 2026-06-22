import { hapticCommit } from '@meza/core';
import type { RefObject } from 'react';
import { useEffect, useLayoutEffect, useRef } from 'react';
import type { TouchSample } from './swipeBack.helpers.ts';
import {
  COMMIT_EASE,
  commitDuration,
  computeVelocity,
  DIRECTION_LOCK_THRESHOLD,
  EDGE_DEADZONE,
  shouldCommit,
  startsInHorizontalScroller,
  VELOCITY_WINDOW_MS,
} from './swipeBack.helpers.ts';

interface UseSwipeBackOptions {
  /** Extra left dead-zone (px) before the gesture arms. Defaults to EDGE_DEADZONE. */
  edgeOffset?: number;
  /** The panel's open state. When provided, leftover inline transform/transition
   *  styles are cleared whenever it changes, so the element's CSS classes own
   *  positioning again (and a reused panel re-opens correctly). */
  open?: boolean;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/**
 * Detects a right-swipe "back" gesture and dismisses the panel.
 *
 * Activates across the full width of the element (minus a small left dead-zone
 * for OS edge gestures), commits on velocity OR distance, and drives the panel
 * with a CSS transform during the drag (GPU accelerated). On release it runs a
 * velocity-matched settle animation. A direction lock allows vertical scrolling,
 * and the gesture refuses to arm inside horizontally-scrollable content.
 *
 * Fires a haptic tap on commit (native Taptic / web vibrate fallback).
 */
export function useSwipeBack(
  ref: RefObject<HTMLElement | null>,
  onClose: () => void,
  options?: UseSwipeBackOptions,
): void {
  const edgeOffset = options?.edgeOffset ?? EDGE_DEADZONE;
  const open = options?.open;
  const startXRef = useRef(0);
  const startYRef = useRef(0);
  const trackingRef = useRef(false);
  const directionLockedRef = useRef(false);
  const samplesRef = useRef<TouchSample[]>([]);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    // Explicit non-null type so `el` stays HTMLElement inside the nested
    // handlers below (TS doesn't carry outer narrowing into closures).
    const el: HTMLElement = node;

    let pendingHandler: (() => void) | null = null;
    let pendingTimer: ReturnType<typeof setTimeout> | null = null;

    // Cancel any in-flight settle animation so a re-arm or unmount can't fire a
    // delayed/duplicate onClose.
    function clearPending() {
      if (pendingHandler) {
        el.removeEventListener('transitionend', pendingHandler);
        pendingHandler = null;
      }
      if (pendingTimer != null) {
        clearTimeout(pendingTimer);
        pendingTimer = null;
      }
    }

    // Run `done` on transitionend, with a timer fallback in case the transition
    // never fires (e.g. interrupted), exactly once.
    function settle(durationMs: number, done: () => void) {
      const finish = () => {
        clearPending();
        done();
      };
      pendingHandler = finish;
      el.addEventListener('transitionend', finish, { once: true });
      pendingTimer = setTimeout(finish, durationMs + 60);
    }

    function abort() {
      trackingRef.current = false;
      directionLockedRef.current = false;
      samplesRef.current = [];
      el.style.transition = '';
      el.style.transform = '';
    }

    function handleTouchStart(e: TouchEvent) {
      clearPending();
      // Ignore multi-touch gestures (pinch-zoom etc.).
      if (e.touches.length > 1) {
        trackingRef.current = false;
        return;
      }
      const touch = e.touches[0];
      if (!touch) return;
      const rect = el.getBoundingClientRect();
      const relativeX = touch.clientX - rect.left;
      // Full-width activation, minus the left dead-zone for OS edge gestures.
      if (relativeX < edgeOffset) return;
      if (startsInHorizontalScroller(e.target, el)) return;
      trackingRef.current = true;
      directionLockedRef.current = false;
      startXRef.current = touch.clientX;
      startYRef.current = touch.clientY;
      samplesRef.current = [{ x: touch.clientX, t: e.timeStamp }];
      el.style.transition = 'none';
    }

    function handleTouchMove(e: TouchEvent) {
      if (!trackingRef.current) return;
      // A second finger landing mid-drag aborts the gesture.
      if (e.touches.length > 1) {
        abort();
        return;
      }
      const touch = e.touches[0];
      if (!touch) return;
      const dx = touch.clientX - startXRef.current;
      const dy = touch.clientY - startYRef.current;

      // Direction lock: decide horizontal swipe vs vertical scroll once movement
      // exceeds the threshold; vertical-dominant aborts to allow scrolling.
      if (
        !directionLockedRef.current &&
        (Math.abs(dx) > DIRECTION_LOCK_THRESHOLD ||
          Math.abs(dy) > DIRECTION_LOCK_THRESHOLD)
      ) {
        directionLockedRef.current = true;
        if (Math.abs(dy) > Math.abs(dx)) {
          abort();
          return;
        }
      }

      samplesRef.current.push({ x: touch.clientX, t: e.timeStamp });
      const cutoff = e.timeStamp - VELOCITY_WINDOW_MS - 1;
      while (
        samplesRef.current.length > 2 &&
        samplesRef.current[0].t < cutoff
      ) {
        samplesRef.current.shift();
      }

      el.style.transform = `translateX(${Math.max(0, dx)}px)`;
    }

    function handleTouchEnd(e: TouchEvent) {
      if (!trackingRef.current) return;
      trackingRef.current = false;
      const touch = e.changedTouches[0];
      const width = el.getBoundingClientRect().width;
      const dx = touch ? touch.clientX - startXRef.current : 0;
      const velocity = computeVelocity(samplesRef.current);
      samplesRef.current = [];
      const reducedMotion = prefersReducedMotion();

      if (touch && shouldCommit({ dx, width, velocity })) {
        hapticCommit();
        if (reducedMotion) {
          // No animation: snap off-screen instantly, then close. The open-state
          // layout effect clears the inline styles once `open` flips false.
          el.style.transition = 'none';
          el.style.transform = `translateX(${width}px)`;
          onClose();
          return;
        }
        const duration = commitDuration({
          remainingPx: Math.max(0, width - dx),
          velocity,
          reducedMotion,
        });
        el.style.transition = `transform ${duration}ms ${COMMIT_EASE}`;
        el.style.transform = `translateX(${width}px)`;
        // Don't clear inline styles here: keep the panel off-screen across the
        // async onClose → history.back() → popstate gap. The open-state layout
        // effect clears them once `open` flips false.
        settle(duration, onClose);
      } else {
        // Cancel: spring back to origin.
        if (reducedMotion || dx <= 0) {
          el.style.transition = '';
          el.style.transform = '';
          return;
        }
        const duration = commitDuration({
          remainingPx: dx,
          velocity,
          reducedMotion,
        });
        el.style.transition = `transform ${duration}ms ${COMMIT_EASE}`;
        el.style.transform = 'translateX(0px)';
        settle(duration, () => {
          el.style.transition = '';
          el.style.transform = '';
        });
      }
    }

    function handleTouchCancel() {
      clearPending();
      abort();
    }

    el.addEventListener('touchstart', handleTouchStart, { passive: true });
    el.addEventListener('touchmove', handleTouchMove, { passive: true });
    el.addEventListener('touchend', handleTouchEnd, { passive: true });
    el.addEventListener('touchcancel', handleTouchCancel, { passive: true });

    return () => {
      clearPending();
      el.removeEventListener('touchstart', handleTouchStart);
      el.removeEventListener('touchmove', handleTouchMove);
      el.removeEventListener('touchend', handleTouchEnd);
      el.removeEventListener('touchcancel', handleTouchCancel);
    };
  }, [ref, onClose, edgeOffset]);

  // When the panel's open state changes, drop any leftover inline transform/
  // transition so the element's CSS classes own positioning again. Runs before
  // paint to avoid a flash, and fixes reuse of a panel that was swiped closed.
  useLayoutEffect(() => {
    if (open === undefined) return;
    const el = ref.current;
    if (!el) return;
    el.style.transition = '';
    el.style.transform = '';
  }, [ref, open]);
}
