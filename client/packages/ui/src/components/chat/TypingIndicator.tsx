import { useTypingStore } from '@meza/core';
import { useMemo } from 'react';
import { useDisplayColor } from '../../hooks/useDisplayColor.ts';
import { useDisplayName } from '../../hooks/useDisplayName.ts';

interface TypingIndicatorProps {
  channelId: string;
  serverId?: string;
}

export function TypingIndicator({ channelId, serverId }: TypingIndicatorProps) {
  const channelTyping = useTypingStore((s) => s.byChannel[channelId]);

  const activeUsers = useMemo(() => {
    if (!channelTyping) return [];
    const now = Date.now();
    return Object.entries(channelTyping)
      .filter(([, expiresAt]) => now < expiresAt)
      .map(([userId]) => userId);
  }, [channelTyping]);

  if (activeUsers.length === 0) return null;

  return (
    <div className="px-4 py-1 text-xs text-text-muted">
      {activeUsers.length >= 3 ? (
        'Several people are typing'
      ) : activeUsers.length === 2 ? (
        <>
          <TypingName userId={activeUsers[0]} serverId={serverId} />
          {' and '}
          <TypingName userId={activeUsers[1]} serverId={serverId} />
          {' are typing'}
        </>
      ) : (
        <>
          <TypingName userId={activeUsers[0]} serverId={serverId} />
          {' is typing'}
        </>
      )}
      <span className="inline-flex gap-0.5 ml-0.5">
        <span className="animate-pulse">.</span>
        <span className="animate-pulse [animation-delay:150ms]">.</span>
        <span className="animate-pulse [animation-delay:300ms]">.</span>
      </span>
    </div>
  );
}

function TypingName({
  userId,
  serverId,
}: {
  userId: string;
  serverId?: string;
}) {
  const name = useDisplayName(userId, serverId);
  const color = useDisplayColor(userId, serverId);
  return (
    <span className="font-medium" style={color ? { color } : undefined}>
      {name}
    </span>
  );
}
