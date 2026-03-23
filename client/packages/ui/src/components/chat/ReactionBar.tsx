import {
  addReaction,
  getMediaURL,
  type ReactionState,
  removeReaction,
  useAuthStore,
  useEmojiStore,
  useReactionStore,
} from '@meza/core';
import * as Popover from '@radix-ui/react-popover';
import { memo, useCallback, useState } from 'react';
import { resolveDisplayName } from '../../hooks/useDisplayName.ts';
import { EmojiPicker } from './EmojiPicker.tsx';

type ReactionGroup = NonNullable<ReactionState['byMessage'][string]>[number];

const CUSTOM_EMOJI_RE = /^<(a?):([a-z0-9_]{2,32}):([a-zA-Z0-9]+)>$/;

interface ReactionBarProps {
  channelId: string;
  messageId: string;
  serverId?: string;
}

export const ReactionBar = memo(function ReactionBar({
  channelId,
  messageId,
  serverId,
}: ReactionBarProps) {
  const groups = useReactionStore((s) => s.byMessage[messageId]);
  const [pickerOpen, setPickerOpen] = useState(false);

  const handlePickerSelect = useCallback(
    (emoji: string) => {
      setPickerOpen(false);
      const userId = useAuthStore.getState().user?.id;
      if (!userId) return;
      useReactionStore.getState().addReaction(messageId, emoji, userId, true);
      addReaction(channelId, messageId, emoji).catch(() => {
        useReactionStore
          .getState()
          .removeReaction(messageId, emoji, userId, true);
      });
    },
    [channelId, messageId],
  );

  if (!groups?.length) return null;

  return (
    <div className="flex flex-wrap items-center gap-1 mt-1">
      {groups.map((group) => (
        <ReactionPill
          key={group.emoji}
          group={group}
          channelId={channelId}
          messageId={messageId}
          serverId={serverId}
        />
      ))}
      <Popover.Root open={pickerOpen} onOpenChange={setPickerOpen}>
        <Popover.Trigger asChild>
          <button
            type="button"
            className="inline-flex h-6 w-6 items-center justify-center rounded text-text-muted hover:bg-bg-surface hover:text-text"
            title="Add reaction"
          >
            +
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            className="z-50 rounded-xl border border-border shadow-lg data-[state=open]:animate-scale-in data-[state=closed]:animate-scale-out"
            side="top"
            align="start"
            sideOffset={8}
            collisionPadding={16}
          >
            <EmojiPicker
              onEmojiSelect={handlePickerSelect}
              serverId={serverId}
            />
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
});

function ReactionPill({
  group,
  channelId,
  messageId,
  serverId,
}: {
  group: ReactionGroup;
  channelId: string;
  messageId: string;
  serverId?: string;
}) {
  const handleClick = useCallback(() => {
    const userId = useAuthStore.getState().user?.id;
    if (!userId) return;
    if (group.me) {
      useReactionStore
        .getState()
        .removeReaction(messageId, group.emoji, userId, true);
      removeReaction(channelId, messageId, group.emoji).catch(() => {
        useReactionStore
          .getState()
          .addReaction(messageId, group.emoji, userId, true);
      });
    } else {
      useReactionStore
        .getState()
        .addReaction(messageId, group.emoji, userId, true);
      addReaction(channelId, messageId, group.emoji).catch(() => {
        useReactionStore
          .getState()
          .removeReaction(messageId, group.emoji, userId, true);
      });
    }
  }, [channelId, messageId, group.emoji, group.me]);

  const tooltip =
    group.userIds.length <= 10
      ? group.userIds
          .map((id: string) => resolveDisplayName(id, serverId))
          .join(', ')
      : `${group.userIds
          .slice(0, 10)
          .map((id: string) => resolveDisplayName(id, serverId))
          .join(', ')} and ${group.userIds.length - 10} others`;

  return (
    <button
      type="button"
      onClick={handleClick}
      title={tooltip}
      className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs border transition-colors ${
        group.me
          ? 'bg-accent/10 border-accent/30 text-text hover:bg-accent/20'
          : 'bg-bg-surface border-border text-text-muted hover:bg-bg-elevated'
      }`}
    >
      <EmojiDisplay emoji={group.emoji} serverId={serverId} />
      <span>{group.userIds.length}</span>
    </button>
  );
}

function EmojiDisplay({
  emoji,
  serverId,
}: {
  emoji: string;
  serverId?: string;
}) {
  const match = CUSTOM_EMOJI_RE.exec(emoji);
  const emojis = useEmojiStore((s) =>
    serverId ? s.byServer[serverId] : undefined,
  );

  if (match) {
    const [, , name, id] = match;
    const custom = emojis?.find((e) => e.id === id);
    if (custom) {
      const attachmentId = custom.imageUrl.replace('/media/', '');
      return (
        <img
          src={getMediaURL(attachmentId)}
          alt={`:${name}:`}
          className="inline-block h-4.5 w-4.5 object-contain"
          loading="lazy"
        />
      );
    }
    return <span>:{name}:</span>;
  }

  return <span style={{ fontSize: 18 }}>{emoji}</span>;
}
