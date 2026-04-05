import type { BadgeAdapter } from './sync.ts';

interface CapacitorBadgePlugin {
  set(options: { count: number }): Promise<void>;
  clear(): Promise<void>;
}

export class CapacitorBadgeAdapter implements BadgeAdapter {
  private badgePromise: Promise<CapacitorBadgePlugin> | null = null;

  private getBadge(): Promise<CapacitorBadgePlugin> {
    if (!this.badgePromise) {
      // Dynamic import — the actual module is installed only in the mobile package.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.badgePromise = (import('@capawesome/capacitor-badge' as any) as Promise<{ Badge: CapacitorBadgePlugin }>)
        .then((m) => m.Badge)
        .catch(() => {
          this.badgePromise = null;
          throw new Error('Badge plugin not available');
        });
    }
    return this.badgePromise;
  }

  setBadgeCount(count: number): void {
    this.getBadge()
      .then((badge) => {
        if (count > 0) {
          return badge.set({ count });
        }
        return badge.clear();
      })
      .catch(() => {});
  }
}
