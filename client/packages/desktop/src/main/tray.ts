import { app, type BrowserWindow, Menu, nativeImage, Tray } from 'electron';
import path from 'node:path';

let tray: Tray | null = null;

function resourcePath(filename: string): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, filename);
  }
  return path.join(__dirname, '../../build', filename);
}

export function createTray(win: BrowserWindow): Tray {
  let icon: Electron.NativeImage;

  if (process.platform === 'darwin') {
    // macOS: use dedicated small monochrome template icon for the menu bar
    const trayIconPath = resourcePath('trayTemplate.png');
    icon = nativeImage.createFromPath(trayIconPath);
    if (!icon.isEmpty()) {
      icon.setTemplateImage(true);
    }
  } else {
    // Windows/Linux: use the full app icon
    icon = nativeImage.createFromPath(resourcePath('icon.png'));
  }

  if (icon.isEmpty()) {
    console.warn('Tray icon not found; tray may be invisible.');
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

  if (process.platform !== 'darwin') {
    tray.on('click', () => {
      if (win.isVisible()) {
        win.hide();
      } else {
        win.show();
        win.focus();
      }
    });
  }

  return tray;
}

export function destroyTray(): void {
  if (tray) {
    tray.destroy();
    tray = null;
  }
}
