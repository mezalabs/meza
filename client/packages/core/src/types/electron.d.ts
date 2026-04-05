export type UpdateUrgency = 'patch' | 'minor' | 'major';

export type UpdateStatus =
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
    check: () => Promise<void>;
    install: () => Promise<void>;
    onStatus: (callback: (status: UpdateStatus) => void) => () => void;
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
