import {
  CloudArrowUp,
  DeviceMobile,
  GitBranch,
  LockKey,
  SquaresFour,
  Star,
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
      <div className="h-10 border-b border-border bg-bg-surface flex items-center px-3 shrink-0">
        <Star size={14} weight="fill" className="text-text-muted mr-1.5" />
        <span className="text-sm font-medium text-text">features</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-md mx-auto py-8 px-4 flex flex-col gap-6">
          {features.map((feature) => (
            <div key={feature.title} className="flex items-start gap-4">
              <feature.icon
                size={24}
                weight="fill"
                className="text-accent shrink-0 mt-0.5"
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
