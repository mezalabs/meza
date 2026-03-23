import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  app,
  BrowserWindow,
  desktopCapturer,
  nativeImage,
  protocol,
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

const DEFAULT_SERVER_URL = 'https://meza.chat';

// On Linux, enable PipeWire-based screen capture so getDisplayMedia() goes
// through xdg-desktop-portal natively (single dialog, no desktopCapturer).
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer');
}

// Register a custom scheme that behaves like https:// so bundled web files
// get a proper origin, secure context, and working fetch/WebSocket/crypto.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'meza',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

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
    ...(!isMac
      ? {
          icon: path.join(process.resourcesPath, 'icon.png'),
        }
      : {}),
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

  // Dev: load from Vite dev server (always localhost unless MEZA_SERVER_URL).
  // Prod (or DESKTOP_PROD=1): load bundled web files via meza:// custom protocol.
  const prodMode = app.isPackaged || process.env.DESKTOP_PROD === '1';
  const serverUrl =
    process.env.MEZA_SERVER_URL ||
    (prodMode ? store.get('settings').serverUrl : '');
  if (!prodMode) {
    win.loadURL(serverUrl || 'http://localhost:4080');
  } else if (serverUrl) {
    win.loadURL(serverUrl);
  } else {
    win.loadURL('meza://app/index.html');
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
  // Serve bundled web files under meza:// so they have a proper origin.
  // Uses direct fs.readFile instead of net.fetch(file://) to avoid the
  // double network-stack hop (meza:// → file://) on every asset load.
  const rendererDir = path.join(import.meta.dirname, '../renderer');
  const MIME_TYPES: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.webp': 'image/webp',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.wasm': 'application/wasm',
    '.mp3': 'audio/mpeg',
    '.ogg': 'audio/ogg',
    '.wav': 'audio/wav',
    '.avif': 'image/avif',
  };
  protocol.handle('meza', async (request) => {
    let { pathname } = new URL(request.url);
    if (pathname === '/' || !path.extname(pathname)) {
      pathname = '/index.html';
    }
    const filePath = path.join(rendererDir, pathname);
    // Prevent path traversal outside the renderer directory
    if (
      !filePath.startsWith(rendererDir + path.sep) &&
      filePath !== rendererDir
    ) {
      return new Response('Forbidden', { status: 403 });
    }
    try {
      const buffer = await readFile(filePath);
      const ext = path.extname(pathname).toLowerCase();
      return new Response(buffer, {
        headers: {
          'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
        },
      });
    } catch {
      return new Response('Not Found', { status: 404 });
    }
  });

  // Bridge cross-origin requests to the real server for CORS + WebSocket.
  // In dev mode the page origin is http://localhost:*, in prod it's meza://app.
  // URL filters ensure these callbacks ONLY fire for server requests, not local assets.
  const serverUrl =
    process.env.MEZA_SERVER_URL ||
    store.get('settings').serverUrl ||
    DEFAULT_SERVER_URL;
  const serverOrigin = new URL(serverUrl).origin;
  const serverHost = new URL(serverUrl).host;
  const serverFilter = {
    urls: [`https://${serverHost}/*`, `wss://${serverHost}/*`],
  };

  session.defaultSession.webRequest.onBeforeSendHeaders(
    serverFilter,
    (details, callback) => {
      // Rewrite non-server origins (meza:// or http://localhost:*) to the
      // real server origin so the server's CORS check passes.
      const origin = details.requestHeaders.Origin;
      if (origin && origin !== serverOrigin) {
        details.requestHeaders.Origin = serverOrigin;
      }
      callback({ requestHeaders: details.requestHeaders });
    },
  );

  session.defaultSession.webRequest.onHeadersReceived(
    serverFilter,
    (details, callback) => {
      // Replace the server's ACAO header with the actual page origin so the
      // browser's CORS check passes on our side.
      const prodMode = app.isPackaged || process.env.DESKTOP_PROD === '1';
      const pageOrigin = prodMode ? 'meza://app' : 'http://localhost:4080';
      const headers = details.responseHeaders ?? {};
      headers['Access-Control-Allow-Origin'] = [pageOrigin];
      callback({ responseHeaders: headers });
    },
  );

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
