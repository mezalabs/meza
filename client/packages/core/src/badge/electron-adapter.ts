import type { BadgeAdapter } from './sync.ts';

export class ElectronBadgeAdapter implements BadgeAdapter {
  setBadgeCount(count: number): void {
    // macOS dock badge + Linux (Unity/GNOME)
    window.electronAPI?.tray.setBadgeCount(count);

    // Windows taskbar overlay
    window.electronAPI?.tray.setOverlayIcon?.(count);
  }
}
