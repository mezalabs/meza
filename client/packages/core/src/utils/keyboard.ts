/**
 * Capacitor Keyboard plugin helpers.
 *
 * Accesses the Keyboard plugin through the global Capacitor plugin
 * registry so we don't need @capacitor/keyboard as a dependency of
 * @meza/core (it's only in the mobile package). On web/desktop,
 * all functions are safe no-ops.
 */

import { isCapacitor } from './platform.ts';

interface PluginListenerHandle {
  remove: () => void;
}

interface KeyboardPlugin {
  hide: () => Promise<void>;
  addListener: (
    event: string,
    cb: (info: { keyboardHeight: number }) => void,
  ) => PluginListenerHandle | Promise<PluginListenerHandle>;
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
  let handle: PluginListenerHandle | null = null;
  try {
    const result = kb.addListener('keyboardWillShow', (info) => {
      cb(info.keyboardHeight);
    });
    // addListener may return a handle directly (sync) or a Promise
    if (result && typeof (result as Promise<PluginListenerHandle>).then === 'function') {
      (result as Promise<PluginListenerHandle>).then((h) => { handle = h; });
    } else {
      handle = result as PluginListenerHandle;
    }
  } catch {}
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
  let handle: PluginListenerHandle | null = null;
  try {
    const result = kb.addListener('keyboardWillHide', () => {
      cb();
    });
    if (result && typeof (result as Promise<PluginListenerHandle>).then === 'function') {
      (result as Promise<PluginListenerHandle>).then((h) => { handle = h; });
    } else {
      handle = result as PluginListenerHandle;
    }
  } catch {}
  return () => {
    handle?.remove();
  };
}
