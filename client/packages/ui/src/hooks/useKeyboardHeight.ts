import { onKeyboardWillHide, onKeyboardWillShow } from '@meza/core';
import { useEffect, useRef, useState } from 'react';

/**
 * Tracks the native keyboard height via Capacitor Keyboard events.
 * Returns 0 when the keyboard is hidden, and the pixel height when visible.
 * Also exposes the last known height (persists after keyboard hides) for
 * sizing the emoji panel to match the keyboard's space.
 */
export function useKeyboardHeight(): {
  height: number;
  lastKnownHeight: number;
} {
  const [height, setHeight] = useState(0);
  const lastKnownRef = useRef(0);

  useEffect(() => {
    const unsub1 = onKeyboardWillShow((h) => {
      lastKnownRef.current = h;
      setHeight(h);
    });
    const unsub2 = onKeyboardWillHide(() => {
      setHeight(0);
    });
    return () => {
      unsub1?.();
      unsub2?.();
    };
  }, []);

  return { height, lastKnownHeight: lastKnownRef.current || 300 };
}
