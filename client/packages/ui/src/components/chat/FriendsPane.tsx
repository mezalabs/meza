import type { FriendRequestEntry, User } from '@meza/core';
import {
  acceptFriendRequest,
  cancelFriendRequest,
  createOrGetDMChannel,
  declineFriendRequest,
  listFriendRequests,
  listFriends,
  removeFriend,
  useFriendStore,
} from '@meza/core';
import { useEffect, useState } from 'react';
import { useTilingStore } from '../../stores/tiling.ts';
import { Avatar } from '../shared/Avatar.tsx';

type Tab = 'all' | 'pending' | 'add';

export function FriendsPane({ tab: initialTab }: { tab?: Tab }) {
  const [activeTab, setActiveTab] = useState<Tab>(initialTab ?? 'all');
  const friends = useFriendStore((s) => s.friends);
  const incomingRequests = useFriendStore((s) => s.incomingRequests);
  const outgoingRequests = useFriendStore((s) => s.outgoingRequests);

  useEffect(() => {
    listFriends().catch(() => {});
    listFriendRequests().catch(() => {});
  }, []);

  const pendingCount = incomingRequests.length;

  return (
    <div className="flex flex-1 min-h-0 min-w-0 flex-col overflow-hidden">
      {/* Tab bar */}
      <div className="flex items-center gap-1 px-4 py-3 border-b border-border bg-bg-secondary">
        <h2 className="text-sm font-semibold text-text-primary mr-4">
          Friends
        </h2>
        <TabButton
          active={activeTab === 'all'}
          onClick={() => setActiveTab('all')}
        >
          All
        </TabButton>
        <TabButton
          active={activeTab === 'pending'}
          onClick={() => setActiveTab('pending')}
          badge={pendingCount}
        >
          Pending
        </TabButton>
        <TabButton
          active={activeTab === 'add'}
          onClick={() => setActiveTab('add')}
        >
          Add Friend
        </TabButton>
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto">
        {activeTab === 'all' && <AllFriendsTab friends={friends} />}
        {activeTab === 'pending' && (
          <PendingTab incoming={incomingRequests} outgoing={outgoingRequests} />
        )}
        {activeTab === 'add' && <AddFriendTab />}
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  badge,
  children,
}: {
  active: boolean;
  onClick: () => void;
  badge?: number;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className={`px-3 py-1 text-xs font-medium rounded transition-colors ${
        active
          ? 'bg-bg-tertiary text-text-primary'
          : 'text-text-subtle hover:text-text-primary hover:bg-bg-tertiary/50'
      }`}
      onClick={onClick}
    >
      {children}
      {badge != null && badge > 0 && (
        <span className="ml-1.5 px-1.5 py-0.5 text-[10px] font-semibold rounded-full bg-accent text-white">
          {badge}
        </span>
      )}
    </button>
  );
}

function AllFriendsTab({ friends }: { friends: User[] }) {
  const setPaneContent = useTilingStore((s) => s.setPaneContent);
  const focusedPaneId = useTilingStore((s) => s.focusedPaneId);

  if (friends.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-text-subtle text-sm p-8">
        <p>No friends yet.</p>
        <p className="mt-1 text-xs">
          Add friends from profile cards or member lists throughout Meza.
        </p>
      </div>
    );
  }

  return (
    <div className="p-2">
      <div className="px-2 py-1 text-xs font-semibold text-text-subtle uppercase">
        All Friends &mdash; {friends.length}
      </div>
      {friends.map((friend) => (
        <FriendRow
          key={friend.id}
          user={friend}
          onMessage={async () => {
            const res = await createOrGetDMChannel(friend.id);
            const channelId = res?.dmChannel?.channel?.id;
            if (channelId && focusedPaneId) {
              setPaneContent(focusedPaneId, {
                type: 'dm',
                conversationId: channelId,
              });
            }
          }}
          onRemove={async () => {
            await removeFriend(friend.id);
            useFriendStore.getState().removeFriend(friend.id);
          }}
        />
      ))}
    </div>
  );
}

function PendingTab({
  incoming,
  outgoing,
}: {
  incoming: FriendRequestEntry[];
  outgoing: FriendRequestEntry[];
}) {
  return (
    <div className="p-2">
      {incoming.length > 0 && (
        <>
          <div className="px-2 py-1 text-xs font-semibold text-text-subtle uppercase">
            Incoming &mdash; {incoming.length}
          </div>
          {incoming.map((req) =>
            req.user ? (
              <IncomingRequestRow key={req.user.id} request={req} />
            ) : null,
          )}
        </>
      )}
      {outgoing.length > 0 && (
        <>
          <div className="px-2 py-1 mt-2 text-xs font-semibold text-text-subtle uppercase">
            Outgoing &mdash; {outgoing.length}
          </div>
          {outgoing.map((req) =>
            req.user ? (
              <OutgoingRequestRow key={req.user.id} request={req} />
            ) : null,
          )}
        </>
      )}
      {incoming.length === 0 && outgoing.length === 0 && (
        <div className="flex items-center justify-center h-32 text-text-subtle text-sm">
          No pending requests
        </div>
      )}
    </div>
  );
}

function AddFriendTab() {
  return (
    <div className="flex flex-col items-center justify-center h-full text-text-subtle text-sm p-8">
      <p className="font-medium text-text-primary">Add Friend</p>
      <p className="mt-2 text-center text-xs max-w-sm">
        You can add friends from profile cards and member lists throughout
        Meza. Click on a user's avatar or name to view their profile, then
        click "Add Friend".
      </p>
    </div>
  );
}

function FriendRow({
  user,
  onMessage,
  onRemove,
}: {
  user: User;
  onMessage: () => Promise<void>;
  onRemove: () => Promise<void>;
}) {
  const [loading, setLoading] = useState(false);

  return (
    <div className="flex items-center gap-3 px-2 py-2 rounded hover:bg-bg-tertiary/50 transition-colors group">
      <Avatar avatarUrl={user.avatarUrl} displayName={user.displayName || user.username || '?'} size="lg" />
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-text-primary truncate">
          {user.displayName || user.username}
        </div>
        <div className="text-xs text-text-subtle truncate">
          @{user.username}
        </div>
      </div>
      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          type="button"
          className="px-2.5 py-1 text-xs font-medium rounded bg-bg-tertiary text-text-primary hover:bg-bg-hover transition-colors"
          disabled={loading}
          onClick={async () => {
            setLoading(true);
            try {
              await onMessage();
            } finally {
              setLoading(false);
            }
          }}
        >
          Message
        </button>
        <button
          type="button"
          className="px-2.5 py-1 text-xs font-medium rounded bg-bg-tertiary text-text-subtle hover:text-red-400 hover:bg-red-500/10 transition-colors"
          disabled={loading}
          onClick={async () => {
            setLoading(true);
            try {
              await onRemove();
            } finally {
              setLoading(false);
            }
          }}
        >
          Remove
        </button>
      </div>
    </div>
  );
}

function IncomingRequestRow({ request }: { request: FriendRequestEntry }) {
  const [loading, setLoading] = useState(false);
  const user = request.user;
  if (!user) return null;

  return (
    <div className="flex items-center gap-3 px-2 py-2 rounded hover:bg-bg-tertiary/50 transition-colors">
      <Avatar avatarUrl={user.avatarUrl} displayName={user.displayName || user.username || '?'} size="lg" />
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-text-primary truncate">
          {user.displayName || user.username}
        </div>
        <div className="text-xs text-text-subtle truncate">
          @{user.username}
        </div>
      </div>
      <div className="flex items-center gap-1">
        <button
          type="button"
          className="px-2.5 py-1 text-xs font-medium rounded bg-green-600 text-white hover:bg-green-500 transition-colors disabled:opacity-50"
          disabled={loading}
          onClick={async () => {
            setLoading(true);
            try {
              await acceptFriendRequest(user.id);
              useFriendStore.getState().removeIncomingRequest(user.id);
              useFriendStore.getState().addFriend(user);
            } finally {
              setLoading(false);
            }
          }}
        >
          Accept
        </button>
        <button
          type="button"
          className="px-2.5 py-1 text-xs font-medium rounded bg-bg-tertiary text-text-subtle hover:text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-50"
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

function OutgoingRequestRow({ request }: { request: FriendRequestEntry }) {
  const [loading, setLoading] = useState(false);
  const user = request.user;
  if (!user) return null;

  return (
    <div className="flex items-center gap-3 px-2 py-2 rounded hover:bg-bg-tertiary/50 transition-colors">
      <Avatar avatarUrl={user.avatarUrl} displayName={user.displayName || user.username || '?'} size="lg" />
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-text-primary truncate">
          {user.displayName || user.username}
        </div>
        <div className="text-xs text-text-subtle truncate">
          @{user.username}
        </div>
      </div>
      <button
        type="button"
        className="px-2.5 py-1 text-xs font-medium rounded bg-bg-tertiary text-text-subtle hover:text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-50"
        disabled={loading}
        onClick={async () => {
          setLoading(true);
          try {
            await cancelFriendRequest(user.id);
            useFriendStore.getState().removeOutgoingRequest(user.id);
          } finally {
            setLoading(false);
          }
        }}
      >
        Cancel
      </button>
    </div>
  );
}
