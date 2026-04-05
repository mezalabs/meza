import { contextBridge, ipcRenderer } from 'electron';

// Update status discriminated union.
// @see canonical definition: client/packages/core/src/types/electron.d.ts
type UpdateUrgency = 'patch' | 'minor' | 'major';
type UpdateStatus =
  | { state: 'idle' }
  | { state: 'checking' }
  | {
      state: 'available';
      version: string;
      urgency: UpdateUrgency;
      releaseUrl: string;
    }
  | {
      state: 'downloading';
      version: string;
      urgency: UpdateUrgency;
      percent: number;
    }
  | {
      state: 'ready';
      version: string;
      urgency: UpdateUrgency;
    }
  | { state: 'error'; message: string };

// Inject the API base URL so Connect-RPC requests target the server.
// In dev mode (empty serverUrl), leave it empty so the web app uses same-origin
// (http://localhost:4080). In prod, the packaged app sets it via the store or
// MEZA_SERVER_URL env var; if still empty, the main process loads meza://app
// which needs an explicit base URL to reach the server.
const serverUrl: string = ipcRenderer.sendSync('settings:getServerUrlSync');
contextBridge.exposeInMainWorld('__MEZA_BASE_URL__', serverUrl);

contextBridge.exposeInMainWorld('electronAPI', {
  // --- Window controls ---
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    maximize: () => ipcRenderer.send('window:maximize'),
    close: () => ipcRenderer.send('window:close'),
    isMaximized: () =>
      ipcRenderer.invoke('window:isMaximized') as Promise<boolean>,
    onMaximizedChange: (callback: (maximized: boolean) => void) => {
      const handler = (_event: unknown, maximized: boolean) =>
        callback(maximized);
      ipcRenderer.on('window:maximized-change', handler);
      return () => {
        ipcRenderer.removeListener('window:maximized-change', handler);
      };
    },
  },

  // --- Native notifications ---
  notifications: {
    show: (title: string, body: string, data?: unknown) =>
      ipcRenderer.send('notification:show', title, body, data),
  },

  // --- System tray ---
  tray: {
    setBadgeCount: (count: number) =>
      ipcRenderer.send('tray:setBadgeCount', count),
  },

  // --- Auto-update ---
  updates: {
    check: () => ipcRenderer.invoke('update:check'),
    install: () => ipcRenderer.invoke('update:install'),
    onStatus: (callback: (status: UpdateStatus) => void) => {
      const handler = (_event: unknown, status: UpdateStatus) =>
        callback(status);
      ipcRenderer.on('update-status', handler);
      return () => {
        ipcRenderer.removeListener('update-status', handler);
      };
    },
  },

  // --- Deep links ---
  deepLink: {
    onNavigate: (callback: (url: string) => void) => {
      const handler = (_event: unknown, url: string) => callback(url);
      ipcRenderer.on('deep-link:navigate', handler);
      return () => {
        ipcRenderer.removeListener('deep-link:navigate', handler);
      };
    },
  },

  // --- Screen sharing (Windows only) ---
  ...(process.platform === 'win32'
    ? {
        screenShare: {
          pick: () =>
            ipcRenderer.invoke('screen-share:pick') as Promise<boolean>,
        },
      }
    : {}),

  // --- App info ---
  app: {
    getVersion: () => ipcRenderer.invoke('app:getVersion') as Promise<string>,
    getPlatform: () => process.platform,
    setAutoLaunch: (enabled: boolean) =>
      ipcRenderer.invoke('app:setAutoLaunch', enabled) as Promise<void>,
    getAutoLaunch: () =>
      ipcRenderer.invoke('app:getAutoLaunch') as Promise<boolean>,
  },

  // --- Settings ---
  settings: {
    getServerUrl: () =>
      ipcRenderer.invoke('settings:getServerUrl') as Promise<string>,
    setServerUrl: (url: string) =>
      ipcRenderer.invoke('settings:setServerUrl', url) as Promise<void>,
    getMinimizeToTray: () =>
      ipcRenderer.invoke('settings:getMinimizeToTray') as Promise<boolean>,
    setMinimizeToTray: (enabled: boolean) =>
      ipcRenderer.invoke(
        'settings:setMinimizeToTray',
        enabled,
      ) as Promise<void>,
  },
});
