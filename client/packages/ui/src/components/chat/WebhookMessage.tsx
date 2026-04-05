import { formatRelativeTime, toISO } from '@meza/core';
import { memo, useMemo } from 'react';
import { Avatar } from '../shared/Avatar.tsx';
import { MarkdownRenderer } from '../shared/MarkdownRenderer.tsx';
import { WebhookEmbed, type WebhookEmbedData } from './WebhookEmbed.tsx';

interface WebhookMessageContent {
  webhook_id: string;
  webhook_name: string;
  username?: string;
  avatar_url?: string;
  content?: string;
  embeds?: WebhookEmbedData[];
}

interface WebhookMessageProps {
  encryptedContent: Uint8Array;
  createdAt?: { seconds: bigint };
  serverId: string | undefined;
}

function parseWebhookContent(raw: Uint8Array): WebhookMessageContent | null {
  try {
    const text = new TextDecoder().decode(raw);
    return JSON.parse(text) as WebhookMessageContent;
  } catch {
    return null;
  }
}

export const WebhookMessage = memo(function WebhookMessage({
  encryptedContent,
  createdAt,
  serverId,
}: WebhookMessageProps) {
  const parsed = useMemo(
    () => parseWebhookContent(encryptedContent),
    [encryptedContent],
  );

  if (!parsed) {
    return (
      <div className="px-4 py-1 text-sm text-text-muted">
        Failed to parse webhook message
      </div>
    );
  }

  const displayName = parsed.username || parsed.webhook_name || 'Webhook';
  const avatarUrl = parsed.avatar_url || undefined;
  const time = createdAt
    ? new Date(Number(createdAt.seconds) * 1000)
    : null;

  return (
    <div className="group relative flex flex-col px-4 py-1 hover:bg-bg-secondary/50">
      <div className="flex items-start gap-2">
        {/* Avatar */}
        <div className="mt-0.5 flex-shrink-0">
          <Avatar
            avatarUrl={avatarUrl}
            displayName={displayName}
            size="md"
          />
        </div>

        {/* Content column */}
        <div className="min-w-0 flex-1 select-text">
          {/* Header: name + BOT badge + timestamp */}
          <div className="flex items-baseline gap-2">
            <span className="text-sm font-medium text-text">
              {displayName}
            </span>
            <span className="inline-flex items-center rounded px-1 py-0.5 text-[10px] font-semibold uppercase leading-none bg-accent/20 text-accent">
              BOT
            </span>
            {time && (
              <span className="text-xs text-text-subtle" title={toISO(time)}>
                {formatRelativeTime(time)}
              </span>
            )}
          </div>

          {/* Message text */}
          {parsed.content && (
            <div className="mt-0.5">
              <MarkdownRenderer content={parsed.content} serverId={serverId} />
            </div>
          )}

          {/* Embeds */}
          {parsed.embeds && parsed.embeds.length > 0 && (
            <div className="flex flex-col gap-1">
              {parsed.embeds.map((embed, i) => (
                <WebhookEmbed key={i} embed={embed} serverId={serverId} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
});
