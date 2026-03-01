import path from 'node:path';
import {
  app,
  BrowserWindow,
  desktopCapturer,
  nativeImage,
  screen,
  session,
} from 'electron';
import {
  extractDeepLinkFromArgs,
  handleDeepLink,
  setupDeepLinks,
} from './deeplink.js';
import { registerIpcHandlers } from './ipc.js';
import { getSavedWindowState, store, trackWindowState } from './store.js';
import { createTray, destroyTray } from './tray.js';
import { initAutoUpdater } from './updater.js';

// On Linux, enable PipeWire-based screen capture so getDisplayMedia() goes
// through xdg-desktop-portal natively (single dialog, no desktopCapturer).
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer');
}

// Single-instance lock
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
}

let mainWindow: BrowserWindow | null = null;

function createWindow(): BrowserWindow {
  const savedState = getSavedWindowState();
  const isMac = process.platform === 'darwin';

  const win = new BrowserWindow({
    x: savedState.x,
    y: savedState.y,
    width: savedState.width,
    height: savedState.height,
    minWidth: 800,
    minHeight: 500,
    frame: false,
    ...(isMac
      ? {
          titleBarStyle: 'hiddenInset',
          trafficLightPosition: { x: 12, y: 10 },
        }
      : {}),
    backgroundColor: '#1a1a1a',
    show: false,
    webPreferences: {
      preload: path.join(import.meta.dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (savedState.isMaximized) {
    win.maximize();
  }

  // Dev: load from Vite dev server. Prod: load embedded web build.
  const serverUrl = store.get('settings').serverUrl;
  if (!app.isPackaged) {
    win.loadURL(serverUrl || 'http://localhost:4080');
  } else if (serverUrl) {
    win.loadURL(serverUrl);
  } else {
    win.loadFile(path.join(import.meta.dirname, '../renderer/index.html'));
  }

  // Show window once content is loaded to avoid white flash
  win.once('ready-to-show', () => {
    const startHidden = process.argv.includes('--hidden');
    if (!startHidden) {
      win.show();
    }
  });

  // Close-to-tray behavior
  win.on('close', (event) => {
    const isQuitting =
      (globalThis as Record<string, unknown>).__mezaIsQuitting === true;
    if (store.get('settings.minimizeToTray') && !isQuitting) {
      event.preventDefault();
      win.hide();
    }
  });

  trackWindowState(win);

  return win;
}

app.on('before-quit', () => {
  (globalThis as Record<string, unknown>).__mezaIsQuitting = true;
});

app.whenReady().then(() => {
  // Enable navigator.mediaDevices.getDisplayMedia() in the renderer.
  // Without setDisplayMediaRequestHandler, getDisplayMedia is blocked entirely.
  if (process.platform === 'linux') {
    // On Linux (Wayland/PipeWire), desktopCapturer.getSources() causes double
    // PipeWire portal dialogs: one for source enumeration, one for capture.
    // Avoid getSources entirely — construct a source from Electron's screen API
    // (which doesn't go through PipeWire) and let PipeWire fire only once
    // when Electron creates the actual capture stream.
    session.defaultSession.setDisplayMediaRequestHandler(
      (_request, callback) => {
        const primary = screen.getPrimaryDisplay();
        const source = {
          id: `screen:${primary.id}:0`,
          name: primary.label || 'Entire Screen',
          thumbnail: nativeImage.createEmpty(),
          display_id: String(primary.id),
          appIcon: nativeImage.createEmpty(),
        };
        callback({
          video: source as Electron.DesktopCapturerSource,
          audio: 'loopback',
        });
      },
    );
  } else {
    // macOS: native system picker; Windows: desktopCapturer fallback.
    session.defaultSession.setDisplayMediaRequestHandler(
      (_request, callback) => {
        desktopCapturer
          .getSources({ types: ['screen', 'window'] })
          .then((sources) => {
            if (sources.length > 0) {
              callback({ video: sources[0], audio: 'loopback' });
            } else {
              callback({});
            }
          })
          .catch(() => {
            callback({});
          });
      },
      { useSystemPicker: process.platform === 'darwin' },
    );
  }

  mainWindow = createWindow();
  registerIpcHandlers(mainWindow);
  createTray(mainWindow);
  setupDeepLinks(mainWindow);

  if (app.isPackaged) {
    initAutoUpdater(mainWindow);
  }
});

// Second instance (Windows/Linux deep links + single-instance enforcement)
app.on('second-instance', (_event, commandLine) => {
  if (!mainWindow) return;
  const deepLink = extractDeepLinkFromArgs(commandLine);
  if (deepLink) {
    handleDeepLink(mainWindow, deepLink);
  } else {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

// macOS: re-create window on dock click
app.on('activate', () => {
  if (mainWindow) {
    mainWindow.show();
  }
});

app.on('window-all-closed', () => {
  destroyTray();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
