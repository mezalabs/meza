import { MEZA_VERSION } from '@meza/core';
import { IconContext } from '@phosphor-icons/react';
import { AuthForm } from './AuthForm.tsx';

export function LandingPage() {
  return (
    <IconContext.Provider value={{ weight: 'fill' }}>
      <div className="flex min-h-0 w-full flex-1 items-start justify-center bg-bg-base pt-[20vh]">
        <div className="w-full max-w-sm space-y-6 px-4">
          {/* Branding */}
          <div className="text-center">
            <h1 className="text-3xl font-bold tracking-tight text-text">
              <span className="text-accent">Meza</span>
            </h1>
            <p className="mt-2 text-sm text-text-muted">
              End-to-end encrypted chat. No tracking, no ads.
            </p>
          </div>

          {/* Auth form */}
          <AuthForm />

          {/* Footer */}
          <p className="text-center text-xs text-text-subtle">
            v{MEZA_VERSION}
          </p>
        </div>
      </div>
    </IconContext.Provider>
  );
}
