import { formatRelativeTime, toISO } from '@meza/core';
import * as Popover from '@radix-ui/react-popover';
import { memo, useMemo, useState } from 'react';
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
    <div className="group relative flex flex-col px-2 py-1 hover:bg-bg-surface/50 transition-colors">
      <div className="flex items-start gap-2">
        {/* Avatar */}
        <WebhookPopover parsed={parsed} avatarUrl={avatarUrl} displayName={displayName}>
          <button type="button" className="mt-0.5 flex-shrink-0 cursor-pointer">
            <Avatar
              avatarUrl={avatarUrl}
              displayName={displayName}
              size="md"
            />
          </button>
        </WebhookPopover>

        {/* Content column */}
        <div className="min-w-0 flex-1 select-text">
          {/* Header: name + BOT badge + timestamp */}
          <div className="flex items-baseline gap-2">
            <WebhookPopover parsed={parsed} avatarUrl={avatarUrl} displayName={displayName}>
              <button type="button" className="text-sm font-medium text-text cursor-pointer hover:underline">
                {displayName}
              </button>
            </WebhookPopover>
            <span className="inline-block translate-y-[-1px] rounded px-1 py-px text-[10px] font-semibold uppercase leading-none bg-accent/20 text-accent">
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

function WebhookPopover({
  parsed,
  avatarUrl,
  displayName,
  children,
}: {
  parsed: WebhookMessageContent;
  avatarUrl: string | undefined;
  displayName: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const hasOverride = parsed.username && parsed.username !== parsed.webhook_name;

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild onContextMenu={() => setOpen(false)}>
        {children}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="z-50 w-64 rounded-lg border border-border bg-bg-overlay shadow-lg data-[state=open]:animate-scale-in data-[state=closed]:animate-scale-out"
          side="top"
          align="center"
          sideOffset={8}
          collisionPadding={16}
        >
          <div className="flex flex-col">
            <div className="h-10 w-full rounded-t-lg bg-bg-surface" />
            <div className="px-3 -mt-4">
              <Avatar
                avatarUrl={avatarUrl}
                displayName={displayName}
                size="lg"
                className="ring-3 ring-bg-overlay"
              />
            </div>
            <div className="px-3 pt-2 pb-3">
              <div className="flex items-center gap-1.5 mb-1">
                <span className="text-base font-semibold text-text truncate">
                  {displayName}
                </span>
                <span className="rounded px-1 py-px text-[10px] font-semibold uppercase leading-none bg-accent/20 text-accent">
                  BOT
                </span>
              </div>

              <div className="space-y-1 text-sm text-text-muted">
                {hasOverride && (
                  <div>
                    <span className="text-text-subtle">Webhook: </span>
                    {parsed.webhook_name}
                  </div>
                )}
                <div>
                  <span className="text-text-subtle">ID: </span>
                  <span className="font-mono text-xs">{parsed.webhook_id}</span>
                </div>
              </div>
            </div>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
