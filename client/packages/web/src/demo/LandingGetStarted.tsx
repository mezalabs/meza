import { AuthForm } from '@meza/ui';

export function LandingGetStarted() {
  return (
    <div className="flex flex-1 min-h-0 min-w-0 flex-col bg-bg-base">
      <div className="flex flex-1 min-h-0 items-center justify-center overflow-y-auto p-4">
        <div className="w-full max-w-sm">
          <AuthForm />
        </div>
      </div>
    </div>
  );
}
