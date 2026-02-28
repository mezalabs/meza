import { PresenceStatus, usePresenceStore } from '@meza/core';

interface PresenceDotProps {
  userId: string;
  size?: 'sm' | 'md';
  className?: string;
}

const sizeClasses = {
  sm: 'h-2 w-2',
  md: 'h-2.5 w-2.5',
} as const;

const statusColors: Record<PresenceStatus, string> = {
  [PresenceStatus.ONLINE]: 'bg-success',
  [PresenceStatus.IDLE]: 'bg-warning',
  [PresenceStatus.DND]: 'bg-error',
  [PresenceStatus.OFFLINE]: 'bg-text-subtle',
  [PresenceStatus.INVISIBLE]: 'bg-text-subtle',
  [PresenceStatus.UNSPECIFIED]: 'bg-text-subtle',
};

const statusNames: Record<PresenceStatus, string> = {
  [PresenceStatus.ONLINE]: 'Online',
  [PresenceStatus.IDLE]: 'Idle',
  [PresenceStatus.DND]: 'Do Not Disturb',
  [PresenceStatus.OFFLINE]: 'Offline',
  [PresenceStatus.INVISIBLE]: 'Invisible',
  [PresenceStatus.UNSPECIFIED]: 'Unknown',
};

export function PresenceDot({
  userId,
  size = 'sm',
  className = '',
}: PresenceDotProps) {
  const status =
    usePresenceStore((s) => s.byUser[userId]?.status) ??
    PresenceStatus.UNSPECIFIED;

  return (
    <span
      className={`inline-block rounded-full ${sizeClasses[size]} ${statusColors[status]} ${className}`}
      title={statusNames[status]}
    />
  );
}
