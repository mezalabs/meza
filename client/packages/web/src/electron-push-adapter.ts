import type { PushAdapter, PushSubscriptionDetails } from '@meza/core';

/**
 * Push adapter for Electron. Registers the device as 'electron' platform
 * and skips Web Push (native notifications are handled via IPC bridge).
 */
export class ElectronPushAdapter implements PushAdapter {
  platform = 'electron' as const;

  async subscribe(): Promise<PushSubscriptionDetails | null> {
    // Electron uses native notifications via IPC, not Web Push.
    // Return null — no push subscription details needed.
    return null;
  }

  async unsubscribe(): Promise<void> {
    // No-op for Electron.
  }
}
