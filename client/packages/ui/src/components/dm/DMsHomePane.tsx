import type { DMChannel, FriendRequestEntry, PaneId } from '@meza/core';
import {
  acceptFriendRequest,
  acceptMessageRequest,
  declineFriendRequest,
  declineMessageRequest,
  getDMDisplayName,
  isGroupDM,
  useAuthStore,
  useDMStore,
  useFriendStore,
  useReadStateStore,
} from '@meza/core';
import {
  ArrowRightIcon,
  ChatCircleDotsIcon,
  PencilSimpleIcon,
  UserPlusIcon,
  UsersThreeIcon,
} from '@phosphor-icons/react';
import { useMemo, useState } from 'react';
import { useTilingStore } from '../../stores/tiling.ts';
import { ProfilePopoverCard } from '../profile/ProfilePopoverCard.tsx';
import { Avatar } from '../shared/Avatar.tsx';
import { PresenceDot } from '../shared/PresenceDot.tsx';
import { CreateGroupDMDialog } from './CreateGroupDMDialog.tsx';

export function DMsHomePane({ paneId }: { paneId: PaneId }) {
  const currentUserId = useAuthStore((s) => s.user?.id) ?? '';
  const dmChannels = useDMStore((s) => s.dmChannels);
  const messageRequests = useDMStore((s) => s.messageRequests);
  const incomingRequests = useFriendStore((s) => s.incomingRequests);
  const readStates = useReadStateStore((s) => s.byChannel);
  const setPaneContent = useTilingStore((s) => s.setPaneContent);

  const [groupDMOpen, setGroupDMOpen] = useState(false);

  const unreadDMs = useMemo(
    () =>
      dmChannels.filter((dm) => {
        const channelId = dm.channel?.id;
        return channelId && (readStates[channelId]?.unreadCount ?? 0) > 0;
      }),
    [dmChannels, readStates],
  );

  // Recent DMs excluding those already in the unread section
  const unreadIds = useMemo(
    () => new Set(unreadDMs.map((dm) => dm.channel?.id)),
    [unreadDMs],
  );
  const recentDMs = useMemo(
    () => dmChannels.filter((dm) => !unreadIds.has(dm.channel?.id)),
    [dmChannels, unreadIds],
  );

  const hasPending = incomingRequests.length > 0 || messageRequests.length > 0;
  const hasConversations = dmChannels.length > 0;

  return (
    <div className="flex flex-1 min-h-0 min-w-0 flex-col overflow-y-auto">
      <div className="w-full max-w-2xl mx-auto px-6 py-8 space-y-8">
        {/* Quick Actions */}
        <section>
          <SectionHeader>Quick Actions</SectionHeader>
          <div className="grid grid-cols-3 gap-3">
            <ActionCard
              icon={<PencilSimpleIcon size={22} aria-hidden="true" />}
              label="New Message"
              subtitle="Message a friend"
              onClick={() => setPaneContent(paneId, { type: 'friends' })}
            />
            <ActionCard
              icon={<UsersThreeIcon size={22} aria-hidden="true" />}
              label="New Group"
              subtitle="Up to 9 people"
              onClick={() => setGroupDMOpen(true)}
            />
            <ActionCard
              icon={<UserPlusIcon size={22} aria-hidden="true" />}
              label="Add Friend"
              subtitle="By username"
              onClick={() =>
                setPaneContent(paneId, { type: 'friends', tab: 'add' })
              }
            />
          </div>
        </section>

        {/* Pending Items */}
        {hasPending && (
          <section>
            <SectionHeader>
              Pending{' '}
              <span className="text-text-muted font-normal">
                {incomingRequests.length + messageRequests.length}
              </span>
            </SectionHeader>
            <div className="space-y-0.5">
              {incomingRequests.slice(0, 4).map((req) =>
                req.user ? (
                  <FriendRequestRow key={req.user.id} request={req} />
                ) : null,
              )}
              {incomingRequests.length >= 5 && (
                <ViewAllRow
                  label={`View all ${incomingRequests.length} pending requests`}
                  onClick={() =>
                    setPaneContent(paneId, {
                      type: 'friends',
                      tab: 'pending',
                    })
                  }
                />
              )}
              {messageRequests
                .slice(0, 4)
                .map((req) => (
                  <MessageRequestRow
                    key={req.channel?.id}
                    request={req}
                    currentUserId={currentUserId}
                    paneId={paneId}
                  />
                ))}
              {messageRequests.length >= 5 && (
                <ViewAllRow
                  label={`View all ${messageRequests.length} message requests`}
                  onClick={() =>
                    setPaneContent(paneId, { type: 'messageRequests' })
                  }
                />
              )}
            </div>
          </section>
        )}

        {/* Unread Conversations */}
        {unreadDMs.length > 0 && (
          <section>
            <SectionHeader>
              Unread{' '}
              <span className="text-text-muted font-normal">
                {unreadDMs.length}
              </span>
            </SectionHeader>
            <div className="space-y-0.5">
              {unreadDMs.map((dm) => (
                <DMRow
                  key={dm.channel?.id}
                  dm={dm}
                  currentUserId={currentUserId}
                  unreadCount={
                    readStates[dm.channel?.id ?? '']?.unreadCount ?? 0
                  }
                  onClick={() =>
                    setPaneContent(paneId, {
                      type: 'dm',
                      conversationId: dm.channel?.id ?? '',
                    })
                  }
                />
              ))}
            </div>
          </section>
        )}

        {/* Recent Conversations */}
        {recentDMs.length > 0 && (
          <section>
            <SectionHeader>
              Recent{' '}
              <span className="text-text-muted font-normal">
                {recentDMs.length}
              </span>
            </SectionHeader>
            <div className="space-y-0.5">
              {recentDMs.map((dm) => (
                <DMRow
                  key={dm.channel?.id}
                  dm={dm}
                  currentUserId={currentUserId}
                  onClick={() =>
                    setPaneContent(paneId, {
                      type: 'dm',
                      conversationId: dm.channel?.id ?? '',
                    })
                  }
                />
              ))}
            </div>
          </section>
        )}

        {/* Empty State */}
        {!hasConversations && !hasPending && (
          <div className="flex flex-col items-center text-center py-16">
            <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-bg-surface">
              <ChatCircleDotsIcon
                size={32}
                className="text-text-subtle"
                aria-hidden="true"
              />
            </div>
            <p className="mt-5 text-text font-medium">No conversations yet</p>
            <p className="mt-1.5 text-sm text-text-muted max-w-xs">
              Start by adding friends or creating a group chat. Your private
              conversations will appear here.
            </p>
          </div>
        )}
      </div>

      <CreateGroupDMDialog open={groupDMOpen} onOpenChange={setGroupDMOpen} />
    </div>
  );
}

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-text-subtle">
      {children}
    </h3>
  );
}

function ActionCard({
  icon,
  label,
  subtitle,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  subtitle: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="flex flex-col items-center gap-2 rounded-xl border border-border bg-bg-surface p-4 transition-colors hover:border-accent/50 hover:bg-bg-elevated"
      onClick={onClick}
    >
      <span className="text-text-muted">{icon}</span>
      <span className="text-sm font-medium text-text">{label}</span>
      <span className="text-xs text-text-subtle">{subtitle}</span>
    </button>
  );
}

function FriendRequestRow({ request }: { request: FriendRequestEntry }) {
  const [loading, setLoading] = useState(false);
  const user = request.user;
  if (!user) return null;

  return (
    <div className="flex items-center gap-3 rounded-lg px-3 py-2.5 transition-colors hover:bg-bg-surface">
      <ProfilePopoverCard userId={user.id}>
        <button type="button" className="flex-shrink-0 cursor-pointer">
          <Avatar
            avatarUrl={user.avatarUrl}
            displayName={user.displayName || user.username || '?'}
            size="lg"
          />
        </button>
      </ProfilePopoverCard>
      <div className="flex-1 min-w-0">
        <ProfilePopoverCard userId={user.id}>
          <button
            type="button"
            className="text-sm font-medium text-text truncate cursor-pointer hover:underline"
          >
            {user.displayName || user.username}
          </button>
        </ProfilePopoverCard>
        <div className="text-xs text-text-subtle">Friend request</div>
      </div>
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          className="rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-black hover:bg-accent-hover transition-colors disabled:opacity-50"
          disabled={loading}
          onClick={async () => {
            setLoading(true);
            try {
              await acceptFriendRequest(user.id);
              useFriendStore.getState().removeIncomingRequest(user.id);
              // biome-ignore lint/suspicious/noExplicitAny: user shape matches User but comes from a narrower type
              useFriendStore.getState().addFriend(user as any);
            } finally {
              setLoading(false);
            }
          }}
        >
          Accept
        </button>
        <button
          type="button"
          className="rounded-md border border-border bg-bg-elevated px-2.5 py-1 text-xs font-medium text-text-muted hover:text-error hover:border-error/30 transition-colors disabled:opacity-50"
          disabled={loading}
          onClick={async () => {
            setLoading(true);
            try {
              await declineFriendRequest(user.id);
              useFriendStore.getState().removeIncomingRequest(user.id);
            } finally {
              setLoading(false);
            }
          }}
        >
          Decline
        </button>
      </div>
    </div>
  );
}

function MessageRequestRow({
  request,
  currentUserId,
  paneId,
}: {
  request: DMChannel;
  currentUserId: string;
  paneId: PaneId;
}) {
  const [loading, setLoading] = useState(false);
  const setPaneContent = useTilingStore((s) => s.setPaneContent);
  const other = request.participants.find((p) => p.id !== currentUserId);
  const channelId = request.channel?.id;
  if (!channelId) return null;

  const avatarEl = (
    <Avatar
      avatarUrl={other?.avatarUrl}
      displayName={other?.displayName || other?.username || '?'}
      size="lg"
    />
  );

  const nameEl = (
    <span className="text-sm font-medium text-text truncate">
      {other?.displayName || other?.username || 'Unknown'}
    </span>
  );

  return (
    <div className="flex items-center gap-3 rounded-lg px-3 py-2.5 transition-colors hover:bg-bg-surface">
      {other ? (
        <ProfilePopoverCard userId={other.id}>
          <button type="button" className="flex-shrink-0 cursor-pointer">
            {avatarEl}
          </button>
        </ProfilePopoverCard>
      ) : (
        <div className="flex-shrink-0">{avatarEl}</div>
      )}
      <div className="flex-1 min-w-0">
        {other ? (
          <ProfilePopoverCard userId={other.id}>
            <button
              type="button"
              className="cursor-pointer hover:underline"
            >
              {nameEl}
            </button>
          </ProfilePopoverCard>
        ) : (
          nameEl
        )}
        <div className="text-xs text-text-subtle">Message request</div>
      </div>
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          className="rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-black hover:bg-accent-hover transition-colors disabled:opacity-50"
          disabled={loading}
          onClick={async () => {
            setLoading(true);
            try {
              await acceptMessageRequest(channelId);
              setPaneContent(paneId, {
                type: 'dm',
                conversationId: channelId,
              });
            } finally {
              setLoading(false);
            }
          }}
        >
          Accept
        </button>
        <button
          type="button"
          className="rounded-md border border-border bg-bg-elevated px-2.5 py-1 text-xs font-medium text-text-muted hover:text-error hover:border-error/30 transition-colors disabled:opacity-50"
          disabled={loading}
          onClick={async () => {
            setLoading(true);
            try {
              await declineMessageRequest(channelId);
            } finally {
              setLoading(false);
            }
          }}
        >
          Decline
        </button>
      </div>
    </div>
  );
}

function ViewAllRow({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm text-accent transition-colors hover:bg-bg-surface"
      onClick={onClick}
    >
      <span className="flex-1 text-left">{label}</span>
      <ArrowRightIcon size={14} aria-hidden="true" />
    </button>
  );
}

function DMRow({
  dm,
  currentUserId,
  unreadCount,
  onClick,
}: {
  dm: DMChannel;
  currentUserId: string;
  unreadCount?: number;
  onClick: () => void;
}) {
  const displayName = getDMDisplayName(dm, currentUserId);
  const group = isGroupDM(dm);
  const other = !group
    ? (dm.participants.find((p) => p.id !== currentUserId) as
        | {
            id: string;
            displayName?: string;
            username?: string;
            avatarUrl?: string;
          }
        | undefined)
    : undefined;
  const hasUnread = (unreadCount ?? 0) > 0;

  return (
    <button
      type="button"
      className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 transition-colors hover:bg-bg-surface ${
        hasUnread ? 'bg-bg-surface/50' : ''
      }`}
      onClick={onClick}
    >
      {/* Avatar: popover for 1-on-1 DMs, plain icon for groups */}
      {group ? (
        <div className="relative flex-shrink-0">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-bg-tertiary text-text-subtle">
            <UsersThreeIcon size={16} aria-hidden="true" />
          </div>
        </div>
      ) : other ? (
        <ProfilePopoverCard userId={other.id}>
          <button
            type="button"
            className="relative flex-shrink-0 cursor-pointer"
            onClick={(e) => e.stopPropagation()}
          >
            <Avatar
              avatarUrl={other.avatarUrl}
              displayName={displayName}
              size="lg"
            />
            <PresenceDot
              userId={other.id}
              size="sm"
              className="absolute -bottom-0.5 -right-0.5 ring-2 ring-bg-base"
            />
          </button>
        </ProfilePopoverCard>
      ) : (
        <div className="relative flex-shrink-0">
          <Avatar displayName={displayName} size="lg" />
        </div>
      )}
      <span
        className={`flex-1 truncate text-left text-sm ${
          hasUnread ? 'font-semibold text-text' : 'text-text-muted'
        }`}
      >
        {!group && other ? (
          <ProfilePopoverCard userId={other.id}>
            <button
              type="button"
              className="cursor-pointer hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              {displayName}
            </button>
          </ProfilePopoverCard>
        ) : (
          displayName
        )}
      </span>
      {group && (
        <span className="text-xs text-text-subtle">
          {dm.participants.length}
        </span>
      )}
      {hasUnread && unreadCount != null && (
        <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-accent px-1.5 text-xs font-bold text-black">
          {unreadCount >= 1000 ? '999+' : unreadCount}
        </span>
      )}
    </button>
  );
}
