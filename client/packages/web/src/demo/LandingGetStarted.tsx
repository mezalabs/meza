import { AuthForm } from '@meza/ui';
import { RocketLaunch as RocketLaunchIcon } from '@phosphor-icons/react';

export function LandingGetStarted() {
  return (
    <div className="flex flex-1 min-h-0 min-w-0 flex-col bg-bg-base">
      {/* Channel header bar */}
      <div className="flex h-10 flex-shrink-0 items-center gap-2 border-b border-border bg-bg-surface px-3">
        <RocketLaunchIcon
          size={14}
          weight="regular"
          className="text-text-muted"
        />
        <span className="text-sm font-medium text-text">#get-started</span>
      </div>

      {/* Content area with AuthForm */}
      <div className="flex flex-1 min-h-0 items-center justify-center overflow-y-auto p-4">
        <div className="w-full max-w-sm">
          <AuthForm />
        </div>
      </div>
    </div>
  );
}
