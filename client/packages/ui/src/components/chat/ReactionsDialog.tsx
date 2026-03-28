import {
  getMediaURL,
  useAuthStore,
  useEmojiStore,
  useReactionStore,
  useUsersStore,
} from '@meza/core';
import * as Dialog from '@radix-ui/react-dialog';
import { memo, useState } from 'react';
import { useDisplayName } from '../../hooks/useDisplayName.ts';
import { Avatar } from '../shared/Avatar.tsx';

const CUSTOM_EMOJI_RE = /^<(a?):([a-z0-9_]{2,32}):([a-zA-Z0-9]+)>$/;

interface ReactionsDialogProps {
  messageId: string;
  serverId?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ReactionsDialog({
  messageId,
  serverId,
  open,
  onOpenChange,
}: ReactionsDialogProps) {
  const groups = useReactionStore((s) => s.byMessage[messageId]);
  const [selectedEmoji, setSelectedEmoji] = useState<string | null>(null);

  // Default to first emoji when dialog opens or selection is invalid
  const activeEmoji =
    selectedEmoji && groups?.some((g) => g.emoji === selectedEmoji)
      ? selectedEmoji
      : (groups?.[0]?.emoji ?? null);

  const activeGroup = groups?.find((g) => g.emoji === activeEmoji);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 animate-fade-in" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl bg-bg-elevated shadow-lg animate-scale-in flex flex-col max-h-[70vh]">
          {/* Header */}
          <div className="flex items-center justify-between px-4 pt-4 pb-2">
            <Dialog.Title className="text-lg font-semibold text-text">
              Reactions
            </Dialog.Title>
            <Dialog.Close asChild>
              <button
                type="button"
                className="rounded p-1 text-text-muted hover:text-text hover:bg-bg-surface"
                aria-label="Close"
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                >
                  <title>Close</title>
                  <path d="M4 4l8 8M12 4l-8 8" />
                </svg>
              </button>
            </Dialog.Close>
          </div>

          {/* Body: emoji tabs + user list */}
          <div className="flex flex-1 min-h-0">
            {/* Emoji sidebar */}
            <div className="flex flex-col gap-1 p-2 border-r border-border overflow-y-auto min-w-[80px]">
              {groups?.map((group) => (
                <button
                  key={group.emoji}
                  type="button"
                  onClick={() => setSelectedEmoji(group.emoji)}
                  className={`flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm transition-colors ${
                    group.emoji === activeEmoji
                      ? 'bg-accent/15 text-text'
                      : 'text-text-muted hover:bg-bg-surface hover:text-text'
                  }`}
                >
                  <EmojiDisplay emoji={group.emoji} serverId={serverId} />
                  <span className="text-xs">{group.userIds.length}</span>
                </button>
              ))}
            </div>

            {/* User list */}
            <div className="flex-1 overflow-y-auto p-2">
              {activeGroup?.userIds.map((userId) => (
                <ReactionUser
                  key={userId}
                  userId={userId}
                  serverId={serverId}
                />
              ))}
              {!activeGroup && (
                <p className="text-sm text-text-muted p-2">No reactions</p>
              )}
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

const ReactionUser = memo(function ReactionUser({
  userId,
  serverId,
}: {
  userId: string;
  serverId?: string;
}) {
  const displayName = useDisplayName(userId, serverId);
  const avatarUrl = useAuthStore((s) =>
    s.user?.id === userId ? s.user.avatarUrl : undefined,
  );
  const cachedAvatarUrl = useUsersStore((s) => s.profiles[userId]?.avatarUrl);
  const username = useUsersStore((s) => s.profiles[userId]?.username);
  const authUsername = useAuthStore((s) =>
    s.user?.id === userId ? s.user.username : undefined,
  );

  const resolvedAvatar = avatarUrl ?? cachedAvatarUrl;
  const resolvedUsername = authUsername ?? username;

  return (
    <div className="flex items-center gap-3 rounded-md px-2 py-1.5">
      <Avatar avatarUrl={resolvedAvatar} displayName={displayName} size="lg" />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-text truncate">
          {displayName}
        </div>
        {resolvedUsername && resolvedUsername !== displayName && (
          <div className="text-xs text-text-muted truncate">
            {resolvedUsername}
          </div>
        )}
      </div>
    </div>
  );
});

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
          className="inline-block h-5 w-5 object-contain"
          loading="lazy"
        />
      );
    }
    return <span>:{name}:</span>;
  }

  return <span style={{ fontSize: 20 }}>{emoji}</span>;
}
