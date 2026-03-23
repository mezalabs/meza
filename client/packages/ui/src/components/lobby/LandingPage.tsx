import { MEZA_VERSION } from '@meza/core';
import { IconContext } from '@phosphor-icons/react';
import { AuthForm } from './AuthForm.tsx';
import { MezaLogo } from './MezaLogo.tsx';

export function LandingPage({
  showDownloads,
}: {
  showDownloads?: boolean;
} = {}) {
  return (
    <IconContext.Provider value={{ weight: 'fill' }}>
      <div className="flex min-h-0 w-full flex-1 items-start justify-center bg-bg-base pt-[20vh]">
        <div className="w-full max-w-sm space-y-6 px-4">
          {/* Branding */}
          <div className="text-center">
            <MezaLogo className="mx-auto h-10 translate-x-1 text-accent" />
            <p className="mt-2 text-sm text-text-muted">
              End-to-end encrypted chat. No tracking, no ads.
            </p>
          </div>

          {/* Auth form */}
          <AuthForm />

          {/* Footer */}
          <div className="flex flex-col items-center gap-2">
            {showDownloads && (
              <a
                href="https://github.com/mezalabs/meza/releases"
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-text-muted transition-colors hover:text-text"
              >
                View downloads
              </a>
            )}
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
