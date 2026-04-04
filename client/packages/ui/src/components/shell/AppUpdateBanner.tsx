import type { UpdateStatus } from '@meza/core';
import { useUpdateStore } from '../../stores/updates.ts';

export function AppUpdateBanner() {
  const status = useUpdateStore((s) => s.status);

  if (
    status.state === 'idle' ||
    status.state === 'checking' ||
    status.state === 'error'
  ) {
    return null;
  }

  // Major tier on mac/win is handled by AppUpdateOverlay — don't show banner
  const platform = window.electronAPI?.app.getPlatform();
  const isLinux = platform === 'linux';
  if (status.urgency === 'major' && !isLinux) return null;

  return (
    <div className={bannerClass(status)}>
      <div className="flex items-center gap-2 text-sm">
        <span className={dotClass(status)} />
        <span className="flex-1">{bannerText(status, isLinux)}</span>
        {bannerAction(status, isLinux)}
      </div>
    </div>
  );
}

// ── Styling helpers ─────────────────────────────────────────────────────

type VisibleStatus = Exclude<UpdateStatus, { state: 'idle' } | { state: 'checking' } | { state: 'error' }>;

function bannerClass(status: VisibleStatus): string {
  const base = 'flex-shrink-0 border-b border-border bg-bg-overlay px-3 py-1.5';
  if (status.state === 'available' || status.state === 'downloading') {
    return `${base}`;
  }
  return base;
}

function dotClass(status: VisibleStatus): string {
  const base = 'h-2 w-2 flex-shrink-0 rounded-full';
  if (status.urgency === 'major') return `${base} bg-error`;
  if (status.urgency === 'minor') return `${base} bg-warning`;
  return `${base} bg-accent animate-pulse`;
}

function bannerText(
  status: VisibleStatus,
  isLinux: boolean,
): string {
  const version = status.version;

  if (isLinux) {
    return `Update v${version} available`;
  }

  if (status.state === 'downloading') {
    return `Downloading update v${version}... ${Math.round(status.percent)}%`;
  }

  if (status.state === 'ready') {
    return `Update v${version} ready`;
  }

  // state === 'available' (brief moment before download starts)
  return `Update v${version} available`;
}

function bannerAction(
  status: VisibleStatus,
  isLinux: boolean,
) {
  if (isLinux && 'releaseUrl' in status) {
    return (
      <a
        href={status.releaseUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="rounded px-2 py-0.5 text-xs font-medium text-text hover:bg-bg-surface transition-colors"
      >
        View on GitHub
      </a>
    );
  }

  if (status.state === 'downloading') {
    return (
      <div className="w-24 h-1.5 rounded-full bg-bg-surface overflow-hidden">
        <div
          className="h-full rounded-full bg-accent transition-[width] duration-300"
          style={{ width: `${Math.min(status.percent, 100)}%` }}
        />
      </div>
    );
  }

  if (status.state === 'ready') {
    const platform = window.electronAPI?.app.getPlatform();
    const label = platform === 'win32' ? 'Install update' : 'Restart to update';
    return (
      <button
        type="button"
        className="rounded px-2 py-0.5 text-xs font-medium text-text hover:bg-bg-surface transition-colors"
        onClick={() => window.electronAPI?.updates.install()}
      >
        {label}
      </button>
    );
  }

  return null;
}
