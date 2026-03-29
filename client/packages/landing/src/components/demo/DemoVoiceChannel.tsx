import { DemoAvatar } from './DemoAvatar';
import type { DemoVoiceParticipant } from './types';

interface DemoVoiceChannelProps {
  channelName: string;
  participants: DemoVoiceParticipant[];
}

export function DemoVoiceChannel({
  channelName,
  participants,
}: DemoVoiceChannelProps) {
  return (
    <div className="flex flex-1 flex-col">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <svg
          aria-hidden="true"
          xmlns="http://www.w3.org/2000/svg"
          width="16"
          height="16"
          fill="currentColor"
          viewBox="0 0 256 256"
          className="text-text-muted"
        >
          <path d="M163.51,24.81a8,8,0,0,0-8.42.88L85.25,80H40A16,16,0,0,0,24,96v64a16,16,0,0,0,16,16H85.25l69.84,54.31A8,8,0,0,0,168,224V32A8,8,0,0,0,163.51,24.81Z" />
        </svg>
        <span className="text-sm font-semibold text-text">{channelName}</span>
        <span className="ml-auto text-xs text-text-subtle">
          {participants.length} connected
        </span>
      </div>

      {/* Participants */}
      <div className="flex flex-1 flex-col items-center justify-center gap-6 p-8">
        <div className="flex flex-wrap justify-center gap-8">
          {participants.map((p) => (
            <div key={p.user.name} className="flex flex-col items-center gap-2">
              <div
                className={`relative rounded-full p-1 ${p.speaking ? 'ring-2 ring-accent animate-pulse' : ''}`}
              >
                <DemoAvatar
                  name={p.user.name}
                  color={p.user.avatarColor}
                  avatarUrl={p.user.avatarUrl}
                  size="lg"
                />
                {p.muted && (
                  <span className="absolute -bottom-0.5 -right-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-error text-white">
                    <svg
                      aria-hidden="true"
                      xmlns="http://www.w3.org/2000/svg"
                      width="12"
                      height="12"
                      fill="currentColor"
                      viewBox="0 0 256 256"
                    >
                      <path d="M213.92,210.62a8,8,0,1,1-11.84,10.76L168,184.21V192a40,40,0,0,1-40,40,8,8,0,0,1,0-16,24,24,0,0,0,24-24v-14.43L42.08,45.38A8,8,0,1,1,53.92,34.62l67.57,74.33A40,40,0,0,0,168,80V128a8,8,0,0,0,16,0V80a56,56,0,0,0-98.11-37Z" />
                    </svg>
                  </span>
                )}
              </div>
              <span className="text-xs text-text-muted">{p.user.name}</span>
            </div>
          ))}
        </div>

        {/* Controls */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="rounded-lg bg-bg-elevated px-4 py-2 text-xs font-medium text-text-muted transition-colors hover:bg-bg-surface"
          >
            Mute
          </button>
          <button
            type="button"
            className="rounded-lg bg-error/20 px-4 py-2 text-xs font-medium text-error transition-colors hover:bg-error/30"
          >
            Disconnect
          </button>
        </div>
      </div>
    </div>
  );
}
