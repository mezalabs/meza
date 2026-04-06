import type { BadgeAdapter } from './sync.ts';

interface CapacitorBadgePlugin {
  set(options: { count: number }): Promise<void>;
  clear(): Promise<void>;
}

export class CapacitorBadgeAdapter implements BadgeAdapter {
  private badgePromise: Promise<CapacitorBadgePlugin> | null = null;
  private pendingOp: Promise<void> = Promise.resolve();

  private getBadge(): Promise<CapacitorBadgePlugin> {
    if (!this.badgePromise) {
      // Dynamic import — the actual module is installed only in the mobile package.
      // The module specifier is built at runtime to prevent Vite from trying to
      // resolve it during the web/desktop build where the package isn't installed.
      const mod = ['@capawesome', 'capacitor-badge'].join('/');
      this.badgePromise = (
        import(/* @vite-ignore */ mod) as Promise<{
          Badge: CapacitorBadgePlugin;
        }>
      )
        .then((m) => m.Badge)
        .catch(() => {
          this.badgePromise = null;
          throw new Error('Badge plugin not available');
        });
    }
    return this.badgePromise;
  }

  setBadgeCount(count: number): void {
    this.pendingOp = this.pendingOp
      .then(() => this.getBadge())
      .then((badge) => (count > 0 ? badge.set({ count }) : badge.clear()))
      .catch((err: unknown) => {
        if (
          err instanceof Error &&
          err.message === 'Badge plugin not available'
        )
          return;
        console.warn('[Badge] Failed to update badge:', err);
      });
  }
}
