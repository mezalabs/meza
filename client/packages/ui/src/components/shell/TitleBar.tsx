import { isElectron } from '@meza/core';
import { useEffect, useState } from 'react';

function WindowControls() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    window.electronAPI?.window.isMaximized().then(setMaximized);
    const cleanup = window.electronAPI?.window.onMaximizedChange(setMaximized);
    return cleanup;
  }, []);

  return (
    <div
      className="flex items-center"
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
    >
      <button
        type="button"
        onClick={() => window.electronAPI?.window.minimize()}
        className="flex h-9 w-12 items-center justify-center text-text-secondary transition-colors hover:bg-bg-overlay"
        aria-label="Minimize"
      >
        <svg
          width="10"
          height="1"
          viewBox="0 0 10 1"
          fill="currentColor"
          aria-hidden="true"
          role="img"
        >
          <title>Minimize</title>
          <rect width="10" height="1" />
        </svg>
      </button>
      <button
        type="button"
        onClick={() => window.electronAPI?.window.maximize()}
        className="flex h-9 w-12 items-center justify-center text-text-secondary transition-colors hover:bg-bg-overlay"
        aria-label={maximized ? 'Restore' : 'Maximize'}
      >
        {maximized ? (
          <svg
            width="10"
            height="10"
            viewBox="0 0 10 10"
            fill="none"
            stroke="currentColor"
            strokeWidth="1"
            aria-hidden="true"
            role="img"
          >
            <title>Restore</title>
            <rect x="2" y="0" width="8" height="8" rx="0.5" />
            <rect x="0" y="2" width="8" height="8" rx="0.5" />
          </svg>
        ) : (
          <svg
            width="10"
            height="10"
            viewBox="0 0 10 10"
            fill="none"
            stroke="currentColor"
            strokeWidth="1"
            aria-hidden="true"
            role="img"
          >
            <title>Maximize</title>
            <rect x="0.5" y="0.5" width="9" height="9" rx="0.5" />
          </svg>
        )}
      </button>
      <button
        type="button"
        onClick={() => window.electronAPI?.window.close()}
        className="flex h-9 w-12 items-center justify-center text-text-secondary transition-colors hover:bg-red-600 hover:text-white"
        aria-label="Close"
      >
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.2"
          aria-hidden="true"
          role="img"
        >
          <title>Close</title>
          <line x1="0" y1="0" x2="10" y2="10" />
          <line x1="10" y1="0" x2="0" y2="10" />
        </svg>
      </button>
    </div>
  );
}

export function TitleBar() {
  if (!isElectron()) return null;

  const platform = window.electronAPI?.app.getPlatform();
  const isMac = platform === 'darwin';

  return (
    <div
      className="flex h-9 shrink-0 items-center bg-bg-base"
      style={
        {
          WebkitAppRegion: 'drag',
          WebkitUserSelect: 'none',
          userSelect: 'none',
        } as React.CSSProperties
      }
    >
      {/* macOS: space for traffic light buttons */}
      {isMac && <div className="w-[78px]" />}
      <span className="px-3 text-xs font-medium text-text-tertiary">Meza</span>
      <div className="flex-1" />
      {/* Windows/Linux: custom window controls */}
      {!isMac && <WindowControls />}
    </div>
  );
}
