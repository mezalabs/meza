import { useTypingStore } from '@meza/core';
import { useMemo } from 'react';
import { resolveDisplayName } from '../../hooks/useDisplayName.ts';

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

  let text: string;
  if (activeUsers.length === 1) {
    text = `${resolveDisplayName(activeUsers[0], serverId)} is typing`;
  } else if (activeUsers.length === 2) {
    text = `${resolveDisplayName(activeUsers[0], serverId)} and ${resolveDisplayName(activeUsers[1], serverId)} are typing`;
  } else {
    text = 'Several people are typing';
  }

  return (
    <div className="px-4 py-1 text-xs text-text-muted">
      {text}
      <span className="inline-flex gap-0.5 ml-0.5">
        <span className="animate-pulse">.</span>
        <span className="animate-pulse [animation-delay:150ms]">.</span>
        <span className="animate-pulse [animation-delay:300ms]">.</span>
      </span>
    </div>
  );
}
