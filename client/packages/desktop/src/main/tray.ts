import path from 'node:path';
import { type BrowserWindow, Menu, nativeImage, Tray } from 'electron';

let tray: Tray | null = null;

export function createTray(win: BrowserWindow): Tray {
  const iconPath = path.join(import.meta.dirname, '../../build/icon.png');
  let icon = nativeImage.createFromPath(iconPath);

  // On macOS, use template image for proper dark/light mode
  if (process.platform === 'darwin' && !icon.isEmpty()) {
    icon.setTemplateImage(true);
  }

  // If icon file is missing, create a minimal 16x16 transparent PNG
  if (icon.isEmpty()) {
    icon = nativeImage.createFromBuffer(Buffer.alloc(0));
  }

  tray = new Tray(icon);
  tray.setToolTip('Meza');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show Meza',
      click: () => {
        win.show();
        win.focus();
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        (globalThis as Record<string, unknown>).__mezaIsQuitting = true;
        win.destroy();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);

  tray.on('click', () => {
    if (win.isVisible()) {
      win.hide();
    } else {
      win.show();
      win.focus();
    }
  });

  return tray;
}

export function destroyTray(): void {
  if (tray) {
    tray.destroy();
    tray = null;
  }
}
