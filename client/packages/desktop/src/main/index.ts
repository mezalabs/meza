import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  app,
  BrowserWindow,
  desktopCapturer,
  ipcMain,
  nativeImage,
  protocol,
  screen,
  session,
  shell,
} from 'electron';
import { DEFAULT_SERVER_URL } from './constants.js';
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
    backgroundColor: '#121212',
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
      // Bridge CORS for the desktop app: the page origin (meza:// or
      // localhost) differs from the server origin, so we rewrite the
      // response headers to satisfy the browser's CORS checks.
      const prodMode = app.isPackaged || process.env.DESKTOP_PROD === '1';
      const pageOrigin = prodMode ? 'meza://app' : 'http://localhost:4080';
      const headers = details.responseHeaders ?? {};

      // Delete any existing ACAO headers (keys are case-sensitive in
      // Electron's responseHeaders, but HTTP headers are case-insensitive).
      for (const key of Object.keys(headers)) {
        if (key.toLowerCase() === 'access-control-allow-origin') {
          delete headers[key];
        }
      }
      headers['Access-Control-Allow-Origin'] = [pageOrigin];

      // The server's Connect-RPC endpoints don't handle OPTIONS — CORS
      // preflight is normally handled by the reverse proxy in production.
      // Ensure preflight responses pass the browser's CORS checks.
      if (details.method === 'OPTIONS') {
        headers['Access-Control-Allow-Methods'] = [
          'GET, POST, PUT, DELETE, OPTIONS',
        ];
        headers['Access-Control-Allow-Headers'] = [
          'Content-Type, Authorization, Connect-Protocol-Version',
        ];
        headers['Access-Control-Max-Age'] = ['86400'];
        callback({
          responseHeaders: headers,
          statusLine: 'HTTP/1.1 204 No Content',
        });
        return;
      }

      callback({ responseHeaders: headers });
    },
  );

  // ── Screen share: first-party picker ──────────────────────────────
  // Unified flow across macOS, Windows, and Linux X11:
  //   1. Renderer calls screen-share:getSources → main enumerates via desktopCapturer
  //   2. Renderer shows picker dialog, user selects → screen-share:select
  //   3. Renderer calls getDisplayMedia() → handler returns pre-selected source
  //
  // Linux Wayland keeps its existing synthetic-source handler because
  // desktopCapturer.getSources() triggers a double PipeWire dialog.

  const isWayland =
    process.platform === 'linux' &&
    (process.env.XDG_SESSION_TYPE === 'wayland' ||
      !!process.env.WAYLAND_DISPLAY);

  // Most recently enumerated sources (kept for source ID validation).
  let enumeratedSources: Electron.DesktopCapturerSource[] = [];
  let enumerating = false;
  let pendingSource: Electron.DesktopCapturerSource | null = null;
  let pendingSourceTimeout: ReturnType<typeof setTimeout> | null = null;

  ipcMain.handle(
    'screen-share:getSources',
    async (event): Promise<
      Array<{ id: string; name: string; thumbnail: string }> | null
    > => {
      if (!mainWindow || event.sender.id !== mainWindow.webContents.id) {
        return null;
      }

      // Wayland: signal renderer to skip picker and use native path.
      if (isWayland) return null;

      // Prevent concurrent enumerations.
      if (enumerating) return null;
      enumerating = true;

      // Clear any stale pending source from a previous picker session.
      pendingSource = null;
      if (pendingSourceTimeout) {
        clearTimeout(pendingSourceTimeout);
        pendingSourceTimeout = null;
      }

      try {
        const scaleFactor = screen.getPrimaryDisplay().scaleFactor;
        const sources = await desktopCapturer.getSources({
          types: ['screen', 'window'],
          thumbnailSize: {
            width: 320 * scaleFactor,
            height: 180 * scaleFactor,
          },
        });

        // Filter out the app's own windows before serializing thumbnails.
        const appWindowIds = BrowserWindow.getAllWindows().map((w) =>
          w.getMediaSourceId(),
        );
        const filtered = sources.filter(
          (s) => !appWindowIds.includes(s.id),
        );

        enumeratedSources = filtered;

        return filtered.map((s) => ({
          id: s.id,
          name: s.name,
          thumbnail: s.thumbnail.isEmpty()
            ? ''
            : s.thumbnail.toJPEG(80).toString('base64'),
        }));
      } catch {
        return [];
      } finally {
        enumerating = false;
      }
    },
  );

  ipcMain.handle(
    'screen-share:select',
    (event, sourceId: string): { success: boolean } => {
      if (!mainWindow || event.sender.id !== mainWindow.webContents.id) {
        return { success: false };
      }

      // Validate sourceId against the most recently enumerated list.
      const source = enumeratedSources.find((s) => s.id === sourceId);
      if (!source) return { success: false };

      pendingSource = source;

      // Expire the pending source after 10 seconds if never consumed.
      if (pendingSourceTimeout) clearTimeout(pendingSourceTimeout);
      pendingSourceTimeout = setTimeout(() => {
        pendingSource = null;
        pendingSourceTimeout = null;
      }, 10_000);

      return { success: true };
    },
  );

  // Open macOS Screen Recording settings from the renderer without
  // window.open() (which creates a BrowserWindow in Electron).
  ipcMain.on('screen-share:openSettings', () => {
    shell.openExternal(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
    );
  });

  if (isWayland) {
    // Linux Wayland: construct a synthetic source from the primary display.
    // PipeWire fires once for the actual capture — no picker dialog.
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
    // macOS, Windows, Linux X11: consume the pre-selected pending source.
    session.defaultSession.setDisplayMediaRequestHandler(
      (_request, callback) => {
        if (pendingSource) {
          if (pendingSourceTimeout) {
            clearTimeout(pendingSourceTimeout);
            pendingSourceTimeout = null;
          }
          callback({ video: pendingSource, audio: 'loopback' });
          pendingSource = null;
        } else {
          callback({});
        }
      },
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
