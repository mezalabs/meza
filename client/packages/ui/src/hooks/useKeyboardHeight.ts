import { onKeyboardWillHide, onKeyboardWillShow } from '@meza/core';
import { useEffect, useRef } from 'react';

/**
 * Tracks the last known native keyboard height via Capacitor Keyboard events.
 *
 * Only subscribes to keyboard events when `active` is true. This is critical
 * on Android: registering Keyboard plugin listeners can interfere with the
 * native `adjustResize` behavior, preventing the composer from moving above
 * the keyboard during normal typing. Only activate when the emoji panel is
 * open and we need the height.
 *
 * Uses a ref (not state) to avoid triggering re-renders.
 */
export function useKeyboardHeight(active: boolean): React.MutableRefObject<number> {
  const heightRef = useRef(300); // sensible default before first keyboard show

  useEffect(() => {
    if (!active) return;

    const unsub1 = onKeyboardWillShow((h) => {
      heightRef.current = h;
    });
    const unsub2 = onKeyboardWillHide(() => {
      // Keep lastKnownHeight — don't reset
    });
    return () => {
      unsub1?.();
      unsub2?.();
    };
  }, [active]);

  return heightRef;
}
