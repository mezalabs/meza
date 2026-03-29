import { useState } from 'react';
import { DemoComposer } from './DemoComposer';
import { DemoMemberList } from './DemoMemberList';
import { DemoMessageList } from './DemoMessageList';
import { DemoSidebar } from './DemoSidebar';
import type { DemoScenario } from './types';

interface DemoShellProps {
  scenario: DemoScenario;
}

export function DemoShell({ scenario }: DemoShellProps) {
  const [activeChannelId, setActiveChannelId] = useState(
    scenario.activeChannelId,
  );

  const activeChannel = scenario.channels.find((c) => c.id === activeChannelId);
  const messages = scenario.messages[activeChannelId] ?? [];

  return (
    <div
      className="flex h-full flex-col overflow-hidden rounded-xl border border-border bg-bg-base shadow-lg"
      role="img"
      aria-label="Interactive demonstration of the Meza chat application"
    >
      {/* Window chrome */}
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <div className="h-3 w-3 rounded-full bg-error/60" />
        <div className="h-3 w-3 rounded-full bg-warning/60" />
        <div className="h-3 w-3 rounded-full bg-success/60" />
        <span className="ml-2 text-xs text-text-subtle">Meza</span>
      </div>

      {/* Main layout */}
      <div className="flex min-h-0 flex-1">
        <DemoSidebar
          servers={scenario.servers}
          channels={scenario.channels}
          activeServerId={scenario.activeServerId}
          activeChannelId={activeChannelId}
          onChannelClick={setActiveChannelId}
        />

        {/* Content area */}
        <div className="flex min-w-0 flex-1 flex-col">
          {/* Channel header */}
          <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
            <span className="text-text-subtle">
              <svg
                aria-hidden="true"
                xmlns="http://www.w3.org/2000/svg"
                width="16"
                height="16"
                fill="currentColor"
                viewBox="0 0 256 256"
              >
                <path d="M224,88H175.4l8.47-46.57a8,8,0,0,0-15.74-2.86l-9,49.43H111.4l8.47-46.57a8,8,0,0,0-15.74-2.86L95.14,88H48a8,8,0,0,0,0,16H92.23L83.5,152H32a8,8,0,0,0,0,16H80.6l-8.47,46.57a8,8,0,0,0,6.44,9.3A7.79,7.79,0,0,0,80,224a8,8,0,0,0,7.86-6.57l9-49.43H144.6l-8.47,46.57a8,8,0,0,0,6.44,9.3A7.79,7.79,0,0,0,144,224a8,8,0,0,0,7.86-6.57l9-49.43H208a8,8,0,0,0,0-16H163.77l8.73-48H224a8,8,0,0,0,0-16ZM147.5,152h-47.73l8.73-48H156.23Z" />
              </svg>
            </span>
            <span className="text-sm font-semibold text-text">
              {activeChannel?.name ?? 'general'}
            </span>
          </div>

          <DemoMessageList
            messages={messages}
            typingUser={
              activeChannelId === scenario.activeChannelId
                ? scenario.typingUser
                : undefined
            }
          />
          <DemoComposer channelName={activeChannel?.name ?? 'general'} />
        </div>

        <DemoMemberList members={scenario.members} />
      </div>
    </div>
  );
}
