import { isCapacitor, isElectron, MEZA_VERSION } from '@meza/core';
import { IconContext } from '@phosphor-icons/react';
import { useState } from 'react';
import { DownloadButton } from './DownloadButton.tsx';
import { LandingPage } from './LandingPage.tsx';
import { MezaLogo } from './MezaLogo.tsx';

export function WebLandingPage() {
  const [showAuth, setShowAuth] = useState(false);

  // Native apps should see the simple auth form, not the marketing page
  if (isElectron() || isCapacitor() || showAuth) {
    return <LandingPage showDownloads />;
  }

  return (
    <IconContext.Provider value={{ weight: 'fill' }}>
      <div className="flex min-h-0 w-full flex-1 justify-center overflow-y-auto bg-bg-base">
        <div className="flex w-full max-w-2xl flex-col items-center gap-10 px-4 py-16 sm:py-24">
          {/* Hero */}
          <div className="flex w-full max-w-sm flex-col items-center gap-6 text-center">
            <MezaLogo className="h-10 translate-x-1 text-accent" />
            <p className="text-sm text-text-muted">
              End-to-end encrypted chat. No tracking, no ads.
            </p>
          </div>

          {/* CTAs */}
          <div className="flex w-full max-w-sm flex-col items-center gap-4">
            <div className="w-full">
              <DownloadButton />
            </div>
            <span className="text-xs text-text-subtle">or</span>
            <button
              type="button"
              onClick={() => setShowAuth(true)}
              className="w-full rounded-lg border border-border bg-bg-surface px-6 py-3.5 text-sm font-medium text-text-muted transition-colors hover:border-border-hover hover:text-text"
            >
              Continue in browser
            </button>
          </div>

          {/* Footer */}
          <div className="flex flex-col items-center gap-2">
            <a
              href="https://meza.chat/privacy"
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-text-muted transition-colors hover:text-text"
            >
              Privacy Policy
            </a>
            <p className="text-xs text-text-subtle">v{MEZA_VERSION}</p>
          </div>
        </div>
      </div>
    </IconContext.Provider>
  );
}
