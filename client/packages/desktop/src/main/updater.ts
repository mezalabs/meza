import { app, type BrowserWindow, ipcMain, powerMonitor } from 'electron';
import pkg from 'electron-updater';

const { autoUpdater } = pkg;

// ── Types (shared with preload/renderer via IPC) ────────────────────────
// Canonical definition: client/packages/core/src/types/electron.d.ts

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

// ── Helpers ─────────────────────────────────────────────────────────────

function getUrgency(current: string, next: string): UpdateUrgency {
  const [cMaj = 0, cMin = 0] = current.split('.').map(Number);
  const [nMaj = 0, nMin = 0] = next.split('.').map(Number);
  if (nMaj > cMaj) return 'major';
  if (nMaj === cMaj && nMin > cMin) return 'minor';
  return 'patch';
}

// ── Main ────────────────────────────────────────────────────────────────

export function initAutoUpdater(win: BrowserWindow): void {
  // Security configuration
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowDowngrade = false;
  autoUpdater.allowPrerelease = false;
  autoUpdater.disableWebInstaller = true;

  // State for current update cycle
  let currentVersion = '';
  let currentUrgency: UpdateUrgency = 'patch';
  let updateDownloaded = false;
  let installTriggered = false;

  // ── Serialized check guard ──────────────────────────────────────────

  let checkInFlight: Promise<unknown> | null = null;

  async function serializedCheck(): Promise<void> {
    if (updateDownloaded) return;
    if (checkInFlight) {
      // If a check is already in flight, wait for it instead of dropping
      await checkInFlight;
      return;
    }
    sendStatus(win, { state: 'checking' });
    checkInFlight = autoUpdater
      .checkForUpdates()
      .catch((err: Error) => {
        // Only forward non-network errors to renderer
        if (!isNetworkError(err)) {
          sendStatus(win, {
            state: 'error',
            message: 'Update check failed. Will retry later.',
          });
        } else {
          sendStatus(win, { state: 'idle' });
        }
      })
      .finally(() => {
        checkInFlight = null;
      });
    await checkInFlight;
  }

  // ── Send status to renderer ─────────────────────────────────────────

  function sendStatus(w: BrowserWindow, status: UpdateStatus): void {
    if (!w.isDestroyed()) {
      w.webContents.send('update-status', status);
    }
  }

  // ── electron-updater events ─────────────────────────────────────────

  autoUpdater.on('update-available', (info) => {
    currentVersion = info.version;
    currentUrgency = getUrgency(app.getVersion(), info.version);

    sendStatus(win, {
      state: 'available',
      version: info.version,
      urgency: currentUrgency,
      releaseUrl: `https://github.com/mezalabs/meza/releases/tag/desktop-v${info.version}`,
    });

    // Trigger download on macOS/Windows (not Linux — can't install in-app)
    if (process.platform !== 'linux') {
      autoUpdater.downloadUpdate().catch((err: Error) => {
        console.error('[updater] Download failed:', err.message);
      });
    }
  });

  autoUpdater.on('update-not-available', () => {
    sendStatus(win, { state: 'idle' });
  });

  // Throttle progress events to ~4/sec
  let lastProgressSent = 0;
  autoUpdater.on('download-progress', (progress) => {
    const now = Date.now();
    if (now - lastProgressSent >= 250 || progress.percent >= 100) {
      lastProgressSent = now;
      sendStatus(win, {
        state: 'downloading',
        version: currentVersion,
        urgency: currentUrgency,
        percent: progress.percent,
      });
    }
  });

  autoUpdater.on('update-downloaded', (info) => {
    updateDownloaded = true;
    // Stop periodic checks — update is ready
    stopPeriodicChecks();
    sendStatus(win, {
      state: 'ready',
      version: info.version,
      urgency: currentUrgency,
    });
  });

  autoUpdater.on('error', (err: Error) => {
    console.error('[updater] Error:', err.message);
    // Don't alarm users for transient network issues
    if (!isNetworkError(err)) {
      sendStatus(win, {
        state: 'error',
        message: 'Update failed. Will retry later.',
      });
    } else {
      // Silently reset — next periodic check will retry
      sendStatus(win, { state: 'idle' });
    }
  });

  // ── IPC handlers ────────────────────────────────────────────────────

  ipcMain.handle('update:check', async (event) => {
    if (event.sender.id !== win.webContents.id) return;
    await serializedCheck();
  });

  ipcMain.handle('update:install', (event) => {
    // Validate sender is the main window
    if (event.sender.id !== win.webContents.id) return;
    // Only install if downloaded and not already triggered
    if (!updateDownloaded || installTriggered) return;
    installTriggered = true;
    autoUpdater.quitAndInstall(false, true);
  });

  // ── Periodic checks with powerMonitor ───────────────────────────────

  const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
  let checkInterval: ReturnType<typeof setInterval> | null = null;
  let pendingTimeout: ReturnType<typeof setTimeout> | null = null;

  function startPeriodicChecks(): void {
    // Delay initial check to avoid blocking startup
    pendingTimeout = setTimeout(() => {
      pendingTimeout = null;
      serializedCheck();
    }, 10_000);
    checkInterval = setInterval(() => serializedCheck(), CHECK_INTERVAL_MS);

    powerMonitor.on('suspend', stopPeriodicChecks);

    powerMonitor.on('resume', () => {
      if (checkInterval) return; // already running
      // Delay to let network reconnect after wake
      pendingTimeout = setTimeout(() => {
        pendingTimeout = null;
        serializedCheck();
      }, 5_000);
      checkInterval = setInterval(() => serializedCheck(), CHECK_INTERVAL_MS);
    });
  }

  function stopPeriodicChecks(): void {
    if (pendingTimeout) {
      clearTimeout(pendingTimeout);
      pendingTimeout = null;
    }
    if (checkInterval) {
      clearInterval(checkInterval);
      checkInterval = null;
    }
  }

  startPeriodicChecks();
}

// ── Utilities ─────────────────────────────────────────────────────────

function isNetworkError(err: Error): boolean {
  const msg = err.message ?? '';
  return (
    msg.includes('net::') ||
    msg.includes('ENOTFOUND') ||
    msg.includes('ETIMEDOUT') ||
    msg.includes('ECONNREFUSED') ||
    msg.includes('ECONNRESET') ||
    msg.includes('ERR_NETWORK')
  );
}
