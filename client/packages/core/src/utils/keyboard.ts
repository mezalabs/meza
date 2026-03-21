/**
 * Capacitor Keyboard plugin helpers.
 *
 * Uses dynamic import so the @capacitor/keyboard package (only in the
 * mobile package) doesn't need to be a dependency of @meza/core.
 * On web/desktop, all functions are safe no-ops.
 */

import { isCapacitor } from './platform.ts';

type KeyboardPlugin = {
  hide: () => Promise<void>;
  addListener: (
    event: string,
    cb: (info: { keyboardHeight: number }) => void,
  ) => Promise<{ remove: () => void }>;
};

let keyboardPlugin: KeyboardPlugin | null = null;
let pluginLoaded = false;

async function getKeyboard(): Promise<KeyboardPlugin | null> {
  if (pluginLoaded) return keyboardPlugin;
  pluginLoaded = true;
  if (!isCapacitor()) return null;
  try {
    // Dynamic import — @capacitor/keyboard is in the mobile package, not core.
    // The module is available at runtime when running in Capacitor.
    // @ts-expect-error — module not in core's deps but available at runtime
    const mod = await import('@capacitor/keyboard');
    keyboardPlugin = mod.Keyboard as unknown as KeyboardPlugin;
    return keyboardPlugin;
  } catch {
    return null;
  }
}

/** Programmatically hide the native keyboard. No-op on web. */
export async function hideKeyboard(): Promise<void> {
  const kb = await getKeyboard();
  try {
    await kb?.hide();
  } catch {}
}

/** Listen for the native keyboard about to show. Returns an unsubscribe function. */
export function onKeyboardWillShow(
  cb: (height: number) => void,
): (() => void) | undefined {
  if (!isCapacitor()) return undefined;
  let cleanup: (() => void) | null = null;
  getKeyboard().then((kb) => {
    if (!kb) return;
    kb.addListener('keyboardWillShow', (info) => {
      cb(info.keyboardHeight);
    }).then((handle) => {
      cleanup = () => handle.remove();
    });
  });
  return () => {
    cleanup?.();
  };
}

/** Listen for the native keyboard about to hide. Returns an unsubscribe function. */
export function onKeyboardWillHide(
  cb: () => void,
): (() => void) | undefined {
  if (!isCapacitor()) return undefined;
  let cleanup: (() => void) | null = null;
  getKeyboard().then((kb) => {
    if (!kb) return;
    kb.addListener('keyboardWillHide', () => {
      cb();
    }).then((handle) => {
      cleanup = () => handle.remove();
    });
  });
  return () => {
    cleanup?.();
  };
}
