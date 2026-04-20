import { type BrowserWindow, screen } from 'electron';
import Store from 'electron-store';

export interface WindowState {
  x: number | undefined;
  y: number | undefined;
  width: number;
  height: number;
  isMaximized: boolean;
}

export interface AppSettings {
  minimizeToTray: boolean;
  autoLaunch: boolean;
  serverUrl: string;
}

export interface KeybindsConfig {
  /**
   * User has explicitly opted into hold-type global keybinds (push-to-talk
   * style). On macOS this is required before we may surface the
   * Accessibility prompt or call uIOhook.start.
   */
  holdGlobalsOptIn: boolean;
}

interface StoreSchema {
  windowState: WindowState;
  settings: AppSettings;
  keybinds: KeybindsConfig;
}

export const store = new Store<StoreSchema>({
  name: 'meza-config',
  defaults: {
    windowState: {
      x: undefined,
      y: undefined,
      width: 1200,
      height: 800,
      isMaximized: false,
    },
    settings: {
      minimizeToTray: true,
      autoLaunch: false,
      serverUrl: '',
    },
    keybinds: {
      holdGlobalsOptIn: false,
    },
  },
});

function isVisibleOnScreen(state: WindowState): boolean {
  const displays = screen.getAllDisplays();
  return displays.some((display) => {
    const { x, y, width, height } = display.bounds;
    return (
      state.x !== undefined &&
      state.y !== undefined &&
      state.x >= x - 100 &&
      state.y >= y - 100 &&
      state.x < x + width &&
      state.y < y + height
    );
  });
}

export function getSavedWindowState(): {
  x: number | undefined;
  y: number | undefined;
  width: number;
  height: number;
  isMaximized: boolean;
} {
  const saved = store.get('windowState');
  const validPosition = isVisibleOnScreen(saved);
  return {
    x: validPosition ? saved.x : undefined,
    y: validPosition ? saved.y : undefined,
    width: saved.width,
    height: saved.height,
    isMaximized: saved.isMaximized,
  };
}

export function trackWindowState(win: BrowserWindow): void {
  let saveTimeout: ReturnType<typeof setTimeout> | null = null;

  const saveState = () => {
    if (saveTimeout) clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => {
      if (win.isDestroyed()) return;
      const bounds = win.getBounds();
      store.set('windowState', {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        isMaximized: win.isMaximized(),
      });
    }, 300);
  };

  win.on('resize', saveState);
  win.on('move', saveState);
  win.on('maximize', saveState);
  win.on('unmaximize', saveState);
  win.on('close', saveState);
}
