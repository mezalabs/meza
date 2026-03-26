import { Hash } from '@phosphor-icons/react';

export function LandingWelcome() {
  return (
    <div className="flex flex-1 min-h-0 min-w-0 flex-col bg-bg-base">
      <div className="h-10 border-b border-border bg-bg-surface flex items-center px-3 shrink-0">
        <Hash size={14} weight="regular" className="text-text-muted mr-1.5" />
        <span className="text-sm font-medium text-text">welcome</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-lg mx-auto py-16 px-4 space-y-10">
          <div className="space-y-4">
            <p className="text-2xl font-bold text-text leading-snug">
              Your group chat is someone else's business model.
            </p>
            <p className="text-2xl font-bold text-text leading-snug">
              Your DMs train someone else's AI.
            </p>
            <p className="text-2xl font-bold text-text leading-snug">
              Your voice calls route through someone else's servers.
            </p>
          </div>

          <p className="text-3xl font-bold text-text leading-snug">
            Meza is chat that shuts up and does its job.
          </p>

          <div className="space-y-1.5">
            <p className="text-lg text-text-muted">
              End-to-end encrypted. No tracking. No ads.
            </p>
            <p className="text-lg text-text-muted">
              No AI training. Open source.
            </p>
            <p className="text-lg text-text-muted">Your messages are yours.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
