export interface ElectronAPI {
  window: {
    minimize: () => void;
    maximize: () => void;
    close: () => void;
    isMaximized: () => Promise<boolean>;
    onMaximizedChange: (callback: (maximized: boolean) => void) => () => void;
  };
  notifications: {
    show: (title: string, body: string, data?: unknown) => void;
  };
  tray: {
    setBadgeCount: (count: number) => void;
  };
  updates: {
    check: () => Promise<unknown>;
    download: () => Promise<void>;
    install: () => void;
    onAvailable: (
      callback: (info: { version: string; releaseNotes?: string }) => void,
    ) => () => void;
    onProgress: (
      callback: (progress: {
        percent: number;
        transferred: number;
        total: number;
      }) => void,
    ) => () => void;
    onDownloaded: (callback: () => void) => () => void;
  };
  deepLink: {
    onNavigate: (callback: (url: string) => void) => () => void;
  };
  app: {
    getVersion: () => Promise<string>;
    getPlatform: () => string;
    setAutoLaunch: (enabled: boolean) => Promise<void>;
    getAutoLaunch: () => Promise<boolean>;
  };
  screenShare?: {
    pick: () => Promise<boolean>;
  };
  settings: {
    getServerUrl: () => Promise<string>;
    setServerUrl: (url: string) => Promise<void>;
    getMinimizeToTray: () => Promise<boolean>;
    setMinimizeToTray: (enabled: boolean) => Promise<void>;
  };
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
    __MEZA_BASE_URL__?: string;
  }
}
