import { app, type BrowserWindow, ipcMain, Notification } from 'electron';
import { getAutoLaunchEnabled, setAutoLaunch } from './autolaunch.js';
import { store } from './store.js';

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
    app.setBadgeCount(count);
  });
}
