import {
  app,
  type BrowserWindow,
  ipcMain,
  Notification,
  nativeImage,
} from 'electron';
import { getAutoLaunchEnabled, setAutoLaunch } from './autolaunch.js';
import { DEFAULT_SERVER_URL } from './constants.js';
import { store } from './store.js';

function createOverlayIcon(count: number): Electron.NativeImage | null {
  if (count <= 0) return null;

  const size = 16;
  const canvas = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
      <circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="#e53935"/>
      <text x="${size / 2}" y="${size / 2}" text-anchor="middle" dy="0.35em"
        font-family="sans-serif" font-size="${count > 9 ? 8 : 10}" font-weight="bold" fill="white">
        ${count > 99 ? '99+' : count}
      </text>
    </svg>`;

  const dataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(canvas.trim())}`;
  return nativeImage.createFromDataURL(dataUrl);
}

export function registerIpcHandlers(win: BrowserWindow): void {
  // --- Window controls ---
  ipcMain.on('window:minimize', () => win.minimize());

  ipcMain.on('window:maximize', () => {
    if (win.isMaximized()) {
      win.unmaximize();
    } else {
      win.maximize();
    }
  });

  ipcMain.on('window:close', () => win.close());

  ipcMain.handle('window:isMaximized', () => win.isMaximized());

  win.on('maximize', () => {
    win.webContents.send('window:maximized-change', true);
  });
  win.on('unmaximize', () => {
    win.webContents.send('window:maximized-change', false);
  });

  // --- Notifications ---
  ipcMain.on(
    'notification:show',
    (_event, title: string, body: string, data?: unknown) => {
      const notification = new Notification({ title, body });
      notification.on('click', () => {
        win.show();
        win.focus();
        if (data && typeof data === 'object' && 'channelId' in data) {
          win.webContents.send(
            'deep-link:navigate',
            `meza://channel/${(data as { channelId: string }).channelId}`,
          );
        }
      });
      notification.show();
    },
  );

  // --- App info ---
  ipcMain.handle('app:getVersion', () => app.getVersion());

  // --- Settings ---
  ipcMain.on('settings:getServerUrlSync', (event) => {
    // In dev mode (not packaged), return empty so the web app uses same-origin
    // (http://localhost:4080). In prod, fall back to the default server URL so
    // the bundled meza://app origin can reach the real server.
    const prodMode = app.isPackaged || process.env.DESKTOP_PROD === '1';
    event.returnValue =
      process.env.MEZA_SERVER_URL ||
      store.get('settings.serverUrl') ||
      (prodMode ? DEFAULT_SERVER_URL : '');
  });

  ipcMain.handle('settings:getServerUrl', () =>
    store.get('settings.serverUrl'),
  );

  ipcMain.handle('settings:setServerUrl', (_event, url: string) => {
    store.set('settings.serverUrl', url);
  });

  ipcMain.handle('settings:getMinimizeToTray', () =>
    store.get('settings.minimizeToTray'),
  );

  ipcMain.handle('settings:setMinimizeToTray', (_event, enabled: boolean) => {
    store.set('settings.minimizeToTray', enabled);
  });

  // --- Auto-launch ---
  ipcMain.handle('app:setAutoLaunch', (_event, enabled: boolean) => {
    setAutoLaunch(enabled);
  });

  ipcMain.handle('app:getAutoLaunch', () => getAutoLaunchEnabled());

  // --- Tray badge ---
  ipcMain.on('tray:setBadgeCount', (_event, count: number) => {
    if (typeof count !== 'number' || !Number.isFinite(count) || count < 0)
      return;
    app.setBadgeCount(Math.floor(count));
  });

  // --- Windows taskbar overlay ---
  ipcMain.on('tray:setOverlayIcon', (_event, count: number) => {
    if (process.platform !== 'win32') return;
    if (typeof count !== 'number' || !Number.isFinite(count) || count < 0)
      return;
    const safeCount = Math.floor(count);
    const overlay = createOverlayIcon(safeCount);
    win.setOverlayIcon(
      overlay,
      safeCount > 0 ? `${safeCount} unread messages` : '',
    );
  });
}
