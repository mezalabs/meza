import type { UpdateStatus } from '@meza/core';
import { useUpdateStore } from '../../stores/updates.ts';

const PLATFORM = window.electronAPI?.app.getPlatform();

export function AppUpdateBanner() {
  const status = useUpdateStore((s) => s.status);

  if (status.state === 'idle' || status.state === 'checking') {
    return null;
  }

  if (status.state === 'error') {
    return (
      <div className="flex-shrink-0 border-b border-border bg-bg-overlay px-3 py-1.5">
        <div className="flex items-center gap-2 text-sm text-text-subtle">
          <span className="h-2 w-2 flex-shrink-0 rounded-full bg-error" />
          <span className="flex-1">Update failed — will retry later</span>
        </div>
      </div>
    );
  }

  // Major tier on mac/win is handled by AppUpdateOverlay — don't show banner
  const isLinux = PLATFORM === 'linux';
  if (status.urgency === 'major' && !isLinux) return null;

  return (
    <div className="flex-shrink-0 border-b border-border bg-bg-overlay px-3 py-1.5">
      <div className="flex items-center gap-2 text-sm">
        <span className={dotClass(status)} />
        <span className="flex-1">{bannerText(status, isLinux)}</span>
        {bannerAction(status, isLinux)}
      </div>
    </div>
  );
}

// ── Helpers ───────────────────────────────��──────────────────────────────

type VisibleStatus = Extract<
  UpdateStatus,
  { state: 'available' } | { state: 'downloading' } | { state: 'ready' }
>;

function dotClass(status: VisibleStatus): string {
  const base = 'h-2 w-2 flex-shrink-0 rounded-full';
  if (status.urgency === 'major') return `${base} bg-error`;
  if (status.urgency === 'minor') return `${base} bg-warning`;
  return `${base} bg-accent animate-pulse`;
}

function bannerText(status: VisibleStatus, isLinux: boolean): string {
  if (isLinux) {
    return `Update v${status.version} available`;
  }
  if (status.state === 'downloading') {
    return `Downloading update v${status.version}... ${Math.round(status.percent)}%`;
  }
  if (status.state === 'ready') {
    return `Update v${status.version} ready`;
  }
  return `Update v${status.version} available`;
}

function bannerAction(
  status: VisibleStatus,
  isLinux: boolean,
): React.ReactNode {
  if (isLinux && status.state === 'available') {
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
          className="h-full rounded-full bg-accent transition-[width] duration-200"
          style={{ width: `${Math.min(status.percent, 100)}%` }}
        />
      </div>
    );
  }

  if (status.state === 'ready') {
    const label = PLATFORM === 'win32' ? 'Install update' : 'Restart to update';
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
