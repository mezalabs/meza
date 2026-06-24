/**
 * Capacitor Haptics plugin helper.
 *
 * Accesses the Haptics plugin through the global Capacitor plugin
 * registry so we don't need @capacitor/haptics as a dependency of
 * @meza/core (it's only in the mobile package), mirroring keyboard.ts.
 * On web/desktop, falls back to navigator.vibrate where available,
 * and is otherwise a safe no-op.
 */

import { isCapacitor } from './platform.ts';

interface HapticsPlugin {
  impact: (opts: { style: string }) => Promise<void>;
}

function getHaptics(): HapticsPlugin | null {
  if (!isCapacitor()) return null;
  try {
    const cap = (window as unknown as Record<string, unknown>).Capacitor as
      | { Plugins?: Record<string, unknown> }
      | undefined;
    const haptics = cap?.Plugins?.Haptics as HapticsPlugin | undefined;
    return haptics ?? null;
  } catch {
    return null;
  }
}

/**
 * Fire a crisp commit tap (e.g. swipe-back complete).
 * Native → Taptic/Vibrator via the Haptics plugin; web PWA → navigator.vibrate;
 * otherwise a no-op. Never throws and never blocks the caller.
 */
export function hapticCommit(): void {
  const haptics = getHaptics();
  if (haptics) {
    // ImpactStyle.Light === 'LIGHT'; pass the string literal so we don't
    // import the enum (and the plugin) into shared code.
    void haptics.impact({ style: 'LIGHT' }).catch(() => {});
    return;
  }
  try {
    if (
      typeof navigator !== 'undefined' &&
      typeof navigator.vibrate === 'function'
    ) {
      navigator.vibrate(10);
    }
  } catch {}
}
