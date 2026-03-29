import type { DemoChannel, DemoServer } from './types';

interface DemoSidebarProps {
  servers: DemoServer[];
  channels: DemoChannel[];
  activeServerId: string;
  activeChannelId: string;
  onChannelClick: (channelId: string) => void;
}

// Inline SVG icons
const hashIcon = (
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
);

const speakerIcon = (
  <svg
    aria-hidden="true"
    xmlns="http://www.w3.org/2000/svg"
    width="16"
    height="16"
    fill="currentColor"
    viewBox="0 0 256 256"
  >
    <path d="M163.51,24.81a8,8,0,0,0-8.42.88L85.25,80H40A16,16,0,0,0,24,96v64a16,16,0,0,0,16,16H85.25l69.84,54.31A8,8,0,0,0,168,224V32A8,8,0,0,0,163.51,24.81ZM152,207.64,92.91,161.69A7.94,7.94,0,0,0,88,160H40V96H88a7.94,7.94,0,0,0,4.91-1.69L152,48.36ZM200,128a39.93,39.93,0,0,1-15.52,31.65,8,8,0,0,1-5,1.73,8,8,0,0,1-5-14.27,24,24,0,0,0,0-38.22,8,8,0,0,1,10-12.47A39.93,39.93,0,0,1,200,128Zm44,0a79.9,79.9,0,0,1-31,63.31,8,8,0,0,1-10-12.47,64,64,0,0,0,0-101.68,8,8,0,1,1,10-12.47A79.9,79.9,0,0,1,244,128Z" />
  </svg>
);

export function DemoSidebar({
  servers,
  channels,
  activeServerId,
  activeChannelId,
  onChannelClick,
}: DemoSidebarProps) {
  return (
    <div className="hidden w-52 flex-shrink-0 flex-col border-r border-border bg-bg-overlay sm:flex">
      {/* Server header */}
      <div className="flex items-center justify-between border-b border-border px-3 py-2.5">
        <span className="text-sm font-semibold text-text">
          {servers.find((s) => s.id === activeServerId)?.name}
        </span>
      </div>

      {/* Channel list */}
      <div className="flex-1 overflow-y-auto p-2">
        <div className="mb-1 px-1 text-[10px] font-semibold uppercase tracking-wider text-text-subtle">
          Text Channels
        </div>
        {channels
          .filter((c) => c.type === 'text')
          .map((channel) => (
            <button
              key={channel.id}
              type="button"
              onClick={() => onChannelClick(channel.id)}
              className={`flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-sm transition-colors ${
                channel.id === activeChannelId
                  ? 'bg-bg-elevated text-text'
                  : 'text-text-muted hover:bg-bg-surface hover:text-text'
              }`}
            >
              <span className="flex-shrink-0 text-text-subtle">{hashIcon}</span>
              <span className="truncate">{channel.name}</span>
              {channel.unread && (
                <span className="ml-auto h-2 w-2 flex-shrink-0 rounded-full bg-accent" />
              )}
            </button>
          ))}

        <div className="mb-1 mt-4 px-1 text-[10px] font-semibold uppercase tracking-wider text-text-subtle">
          Voice Channels
        </div>
        {channels
          .filter((c) => c.type === 'voice')
          .map((channel) => (
            <button
              key={channel.id}
              type="button"
              className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-sm text-text-muted transition-colors hover:bg-bg-surface hover:text-text"
            >
              <span className="flex-shrink-0 text-text-subtle">
                {speakerIcon}
              </span>
              <span className="truncate">{channel.name}</span>
            </button>
          ))}
      </div>

      {/* Server list (bottom) */}
      <div className="flex gap-1.5 border-t border-border p-2">
        {servers.map((server) => (
          <div
            key={server.id}
            className={`flex h-8 w-8 items-center justify-center rounded-lg text-xs font-semibold transition-colors ${
              server.id === activeServerId
                ? 'bg-accent text-black'
                : 'bg-bg-elevated text-text-muted hover:bg-bg-surface'
            }`}
            title={server.name}
          >
            {server.iconLetter}
            {server.unread && server.id !== activeServerId && (
              <span className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-accent" />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
