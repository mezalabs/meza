import { DownloadButton } from '@meza/ui';
import { Hash, RocketLaunch } from '@phosphor-icons/react';

import type { DemoPaneId } from './types.ts';
import { DEMO_CHANNELS } from './types.ts';

interface DemoSidebarProps {
  activeChannel: DemoPaneId;
  onChannelSelect: (id: DemoPaneId) => void;
}

function ChannelIcon({ channelId }: { channelId: DemoPaneId }) {
  if (channelId === 'getStarted') {
    return <RocketLaunch size={16} weight="regular" />;
  }
  return <Hash size={16} weight="regular" />;
}

export function DemoSidebar({
  activeChannel,
  onChannelSelect,
}: DemoSidebarProps) {
  return (
    <aside
      className="flex h-full flex-shrink-0 flex-col bg-bg-overlay"
      style={{ width: 240 }}
    >
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Server rail (left column) */}
        <nav className="flex w-16 flex-shrink-0 flex-col items-center gap-2 overflow-y-auto border-r border-border/40 px-1 py-3">
          {/* Single Meza server icon – active state */}
          <div className="relative flex items-center">
            <span className="absolute left-[-0.625rem] h-5 w-1 rounded-r-full bg-text" />
            <div className="flex h-10 w-10 items-center justify-center rounded-[10px] bg-bg-surface text-accent">
              <svg
                viewBox="0 0 183 164"
                className="h-6 w-6"
                fill="currentColor"
                aria-hidden="true"
              >
                <path d="M18.298,118.732c-11.487,-12.408 -18.298,-27.836 -18.298,-44.548c0,-40.944 40.888,-74.185 91.249,-74.185c50.362,0 91.249,33.241 91.249,74.185c0,40.556 -40.117,73.555 -89.822,74.176c-4.069,0.23 -40.263,2.607 -56.274,15.125c0.685,-28.614 -18.363,-44.855 -18.363,-44.855l0.259,0.103Zm48.454,-23.167c4.437,0 8.301,-1.49 11.592,-4.469c3.291,-2.979 4.936,-7.08 4.936,-12.303c0,-4.561 -1.645,-8.441 -4.936,-11.641c-3.291,-3.2 -7.266,-4.8 -11.924,-4.8c-4.659,0 -8.578,1.618 -11.758,4.855c-3.18,3.237 -4.77,7.099 -4.77,11.586c0,5.296 1.664,9.416 4.992,12.358c3.328,2.942 7.284,4.414 11.869,4.414Zm48.933,0c4.437,0 8.301,-1.49 11.592,-4.469c3.291,-2.979 4.936,-7.08 4.936,-12.303c0,-4.561 -1.645,-8.441 -4.936,-11.641c-3.291,-3.2 -7.266,-4.8 -11.924,-4.8c-4.659,0 -8.578,1.618 -11.758,4.855c-3.18,3.237 -4.77,7.099 -4.77,11.586c0,5.296 1.664,9.416 4.992,12.358c3.328,2.942 7.284,4.414 11.869,4.414Z" />
              </svg>
            </div>
          </div>
        </nav>

        {/* Channel list (right column) */}
        <nav className="flex min-w-0 flex-1 flex-col gap-0.5 overflow-y-auto py-3 pl-1.5 pr-1.5">
          {/* Server name header */}
          <div className="mb-2 flex items-center px-1">
            <h2 className="truncate text-sm font-semibold text-text">Meza</h2>
          </div>

          {/* Channel entries */}
          {DEMO_CHANNELS.map((channel) => {
            const isActive = activeChannel === channel.id;
            return (
              <button
                key={channel.id}
                type="button"
                onClick={() => onChannelSelect(channel.id)}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors ${
                  isActive
                    ? 'bg-bg-elevated text-text'
                    : 'text-text-muted hover:bg-bg-elevated/50 hover:text-text'
                }`}
              >
                <ChannelIcon channelId={channel.id} />
                <span className="truncate">#{channel.name}</span>
              </button>
            );
          })}
        </nav>
      </div>

      {/* Footer: DownloadButton */}
      <div className="border-t border-border p-3">
        <DownloadButton />
      </div>
    </aside>
  );
}
