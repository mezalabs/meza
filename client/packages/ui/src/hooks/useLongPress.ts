import { useCallback, useRef } from 'react';

const DEFAULT_DELAY = 400;
const DEFAULT_MOVE_THRESHOLD = 10;

interface UseLongPressOptions {
  delay?: number;
  moveThreshold?: number;
}

/**
 * Custom long-press detection for touch devices.
 * Fires after `delay` ms (default 400) if the user doesn't move beyond `moveThreshold`.
 * Cancels on movement (allows scrolling and text selection).
 * Triggers haptic feedback via navigator.vibrate on activation.
 *
 * Returns React touch event handlers to spread onto the target element.
 */
export function useLongPress(
  onLongPress: (rect: DOMRect) => void,
  options?: UseLongPressOptions,
) {
  const delay = options?.delay ?? DEFAULT_DELAY;
  const moveThreshold = options?.moveThreshold ?? DEFAULT_MOVE_THRESHOLD;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startRef = useRef({ x: 0, y: 0 });
  const firedRef = useRef(false);

  const clear = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const onTouchStart = useCallback(
    (e: React.TouchEvent) => {
      const touch = e.touches[0];
      if (!touch) return;
      startRef.current = { x: touch.clientX, y: touch.clientY };
      firedRef.current = false;

      const target = e.currentTarget;
      timerRef.current = setTimeout(() => {
        firedRef.current = true;
        // Haptic feedback
        if (navigator.vibrate) navigator.vibrate(10);
        onLongPress(target.getBoundingClientRect());
      }, delay);
    },
    [onLongPress, delay],
  );

  const onTouchMove = useCallback(
    (e: React.TouchEvent) => {
      if (!timerRef.current) return;
      const touch = e.touches[0];
      if (!touch) return;
      const dx = touch.clientX - startRef.current.x;
      const dy = touch.clientY - startRef.current.y;
      if (Math.abs(dx) > moveThreshold || Math.abs(dy) > moveThreshold) {
        clear();
      }
    },
    [clear, moveThreshold],
  );

  const onTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      clear();
      // If long-press fired, prevent the subsequent click/context menu
      if (firedRef.current) {
        e.preventDefault();
      }
    },
    [clear],
  );

  return { onTouchStart, onTouchMove, onTouchEnd };
}
