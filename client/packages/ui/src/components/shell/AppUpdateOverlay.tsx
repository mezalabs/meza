import type { UpdateStatus } from '@meza/core';
import { useUpdateStore } from '../../stores/updates.ts';

const PLATFORM =
  typeof window !== 'undefined'
    ? window.electronAPI?.app.getPlatform()
    : undefined;

export function AppUpdateOverlay() {
  const status = useUpdateStore((s) => s.status);
  const lastMajorVersion = useUpdateStore((s) => s.lastMajorVersion);

  // Only show for major urgency on non-Linux platforms
  if (PLATFORM === 'linux') return null;
  if (!shouldShowOverlay(status, lastMajorVersion)) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-bg/80 backdrop-blur-sm">
      <div className="w-full max-w-sm rounded-xl border border-border bg-bg-surface p-6 shadow-xl">
        <h2 className="text-lg font-semibold text-text">Update Required</h2>
        <p className="mt-2 text-sm text-text-subtle">
          A new version of Meza is available. Please update to continue.
        </p>
        <div className="mt-6">{overlayContent(status)}</div>
      </div>
    </div>
  );
}

function shouldShowOverlay(
  status: UpdateStatus,
  lastMajorVersion: string | null,
): boolean {
  if (
    status.state !== 'idle' &&
    status.state !== 'checking' &&
    status.state !== 'error' &&
    status.urgency === 'major'
  ) {
    return true;
  }
  // Keep overlay visible during errors if we were in a major update flow
  if (status.state === 'error' && lastMajorVersion !== null) {
    return true;
  }
  return false;
}

function overlayContent(status: UpdateStatus): React.ReactNode {
  if (status.state === 'downloading') {
    return (
      <div>
        <div className="flex items-center justify-between text-xs text-text-subtle mb-1.5">
          <span>Downloading...</span>
          <span>{Math.round(status.percent)}%</span>
        </div>
        <div className="h-2 rounded-full bg-bg-overlay overflow-hidden">
          <div
            className="h-full rounded-full bg-accent transition-[width] duration-200"
            style={{ width: `${Math.min(status.percent, 100)}%` }}
          />
        </div>
      </div>
    );
  }

  if (status.state === 'available') {
    return (
      <div className="flex items-center gap-2 text-sm text-text-subtle">
        <span className="h-2 w-2 rounded-full bg-accent animate-pulse" />
        Preparing download...
      </div>
    );
  }

  if (status.state === 'ready') {
    return (
      <button
        type="button"
        className="w-full rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/90 transition-colors"
        onClick={() => window.electronAPI?.updates.install()}
      >
        {PLATFORM === 'win32' ? 'Install update' : 'Restart to update'}
      </button>
    );
  }

  if (status.state === 'error') {
    return (
      <div>
        <p className="text-sm text-error mb-3">{status.message}</p>
        <button
          type="button"
          className="w-full rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/90 transition-colors"
          onClick={() => window.electronAPI?.updates.check()}
        >
          Retry Now
        </button>
      </div>
    );
  }

  return null;
}
