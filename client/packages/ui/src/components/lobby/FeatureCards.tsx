import {
  CloudArrowUp,
  EyeSlash,
  GitBranch,
  LockKey,
} from '@phosphor-icons/react';
import type { ComponentType } from 'react';

interface Feature {
  icon: ComponentType<{ size: number; className?: string }>;
  title: string;
  description: string;
}

const FEATURES: Feature[] = [
  {
    icon: LockKey,
    title: 'End-to-End Encrypted',
    description: 'Messages only you and your recipients can read',
  },
  {
    icon: EyeSlash,
    title: 'No Tracking',
    description: 'Zero analytics, zero ads, zero data collection',
  },
  {
    icon: GitBranch,
    title: 'Open Source',
    description: 'Fully auditable code you can inspect and verify',
  },
  {
    icon: CloudArrowUp,
    title: 'Self-Hostable',
    description: 'Run your own server with full control over your data',
  },
];

export function FeatureCards() {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {FEATURES.map((feature) => (
        <div
          key={feature.title}
          className="flex flex-col gap-2 rounded-lg border border-border bg-bg-surface p-4"
        >
          <feature.icon size={20} className="text-accent" />
          <h3 className="text-xs font-semibold text-text">{feature.title}</h3>
          <p className="text-xs leading-relaxed text-text-muted">
            {feature.description}
          </p>
        </div>
      ))}
    </div>
  );
}
