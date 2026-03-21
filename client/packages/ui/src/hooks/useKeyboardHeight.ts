import { onKeyboardWillHide, onKeyboardWillShow } from '@meza/core';
import { useEffect, useRef } from 'react';

/**
 * Tracks the last known native keyboard height via Capacitor Keyboard events.
 * Uses a ref (not state) to avoid triggering re-renders on every keyboard
 * show/hide — this prevents layout thrashing on Android where the OS
 * resizes the WebView natively.
 *
 * Returns a ref containing the last known keyboard height (defaults to 300
 * if the keyboard hasn't been shown yet). Use .current to read the value.
 */
export function useKeyboardHeight(): React.MutableRefObject<number> {
  const heightRef = useRef(300); // sensible default before first keyboard show

  useEffect(() => {
    const unsub1 = onKeyboardWillShow((h) => {
      heightRef.current = h;
    });
    const unsub2 = onKeyboardWillHide(() => {
      // Keep lastKnownHeight — don't reset to 0
    });
    return () => {
      unsub1?.();
      unsub2?.();
    };
  }, []);

  return heightRef;
}
