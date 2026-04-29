import { isCapacitor } from '@meza/core';

/**
 * Clear every push notification currently sitting in the OS notification
 * tray for this device. Belt-and-braces complement to the user_id
 * cross-account filter in navigateFromPush — that filter handles the tap,
 * this clears the notification itself so it does not visibly persist
 * across user switches on shared devices.
 *
 * Safe to call even when no platform-specific cleanup is available; each
 * branch is best-effort and silent on failure.
 */
export async function clearAllDeliveredNotifications(): Promise<void> {
  // Capacitor (iOS + Android): clear via the PushNotifications plugin.
  if (isCapacitor()) {
    try {
      const { PushNotifications } = await import(
        '@capacitor/push-notifications'
      );
      await PushNotifications.removeAllDeliveredNotifications();
    } catch {
      // Plugin missing or call failed — non-fatal.
    }
  }

  // Web: enumerate notifications shown by the active service-worker
  // registration and close each one.
  if (typeof navigator !== 'undefined' && navigator.serviceWorker) {
    try {
      const reg = await navigator.serviceWorker.ready;
      const list = await reg.getNotifications();
      for (const n of list) n.close();
    } catch {
      // No active SW or browser disallows enumeration — non-fatal.
    }
  }
}
