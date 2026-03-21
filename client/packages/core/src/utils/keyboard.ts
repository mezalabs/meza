/**
 * Capacitor Keyboard plugin helpers.
 *
 * Accesses the Keyboard plugin through the global Capacitor plugin
 * registry so we don't need @capacitor/keyboard as a dependency of
 * @meza/core (it's only in the mobile package). On web/desktop,
 * all functions are safe no-ops.
 */

import { isCapacitor } from './platform.ts';

interface KeyboardPlugin {
  hide: () => Promise<void>;
  addListener: (
    event: string,
    cb: (info: { keyboardHeight: number }) => void,
  ) => Promise<{ remove: () => void }>;
}

function getKeyboard(): KeyboardPlugin | null {
  if (!isCapacitor()) return null;
  try {
    const cap = (window as unknown as Record<string, unknown>).Capacitor as
      | { Plugins?: Record<string, unknown> }
      | undefined;
    const kb = cap?.Plugins?.Keyboard as KeyboardPlugin | undefined;
    return kb ?? null;
  } catch {
    return null;
  }
}

/** Programmatically hide the native keyboard. No-op on web. */
export async function hideKeyboard(): Promise<void> {
  try {
    await getKeyboard()?.hide();
  } catch {}
}

/** Listen for the native keyboard about to show. Returns an unsubscribe function. */
export function onKeyboardWillShow(
  cb: (height: number) => void,
): (() => void) | undefined {
  const kb = getKeyboard();
  if (!kb) return undefined;
  let handle: { remove: () => void } | null = null;
  kb.addListener('keyboardWillShow', (info) => {
    cb(info.keyboardHeight);
  }).then((h) => {
    handle = h;
  });
  return () => {
    handle?.remove();
  };
}

/** Listen for the native keyboard about to hide. Returns an unsubscribe function. */
export function onKeyboardWillHide(
  cb: () => void,
): (() => void) | undefined {
  const kb = getKeyboard();
  if (!kb) return undefined;
  let handle: { remove: () => void } | null = null;
  kb.addListener('keyboardWillHide', () => {
    cb();
  }).then((h) => {
    handle = h;
  });
  return () => {
    handle?.remove();
  };
}
