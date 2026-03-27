import {
  CloudArrowUp,
  DeviceMobile,
  GitBranch,
  LockKey,
  SquaresFour,
  VideoCamera,
} from '@phosphor-icons/react';

const features = [
  {
    icon: LockKey,
    title: 'End-to-end encrypted',
    description: 'All channels, all messages, always. Not optional.',
  },
  {
    icon: VideoCamera,
    title: 'Voice & video',
    description: 'WebRTC, peer-to-peer when possible. No middleman.',
  },
  {
    icon: SquaresFour,
    title: 'Tiling windows',
    description:
      "See multiple channels at once. You're looking at it right now.",
  },
  {
    icon: DeviceMobile,
    title: 'Cross-platform',
    description: 'Web, macOS, Windows, Linux, iOS, Android.',
  },
  {
    icon: CloudArrowUp,
    title: 'Self-hostable',
    description: 'Docker Compose, your server, your rules.',
  },
  {
    icon: GitBranch,
    title: 'Open source',
    description: 'AGPL-3.0. Read every line.',
  },
] as const;

export function LandingFeatures() {
  return (
    <div className="flex flex-1 min-h-0 min-w-0 flex-col bg-bg-base">
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-md flex-col gap-6 px-4 py-8">
          {features.map((feature) => (
            <div key={feature.title} className="flex items-start gap-4">
              <feature.icon
                size={24}
                weight="fill"
                className="mt-0.5 shrink-0 text-accent"
              />
              <div>
                <p className="font-bold text-text">{feature.title}</p>
                <p className="text-sm text-text-muted">{feature.description}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
