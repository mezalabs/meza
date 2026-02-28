import {
  addChannelMember,
  listChannelMembers,
  listMembers,
  removeChannelMember,
} from '@meza/core';
import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useState } from 'react';

interface ChannelMembersDialogProps {
  channelId: string;
  serverId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ChannelMembersDialog({
  channelId,
  serverId,
  open,
  onOpenChange,
}: ChannelMembersDialogProps) {
  const [members, setMembers] = useState<
    Awaited<ReturnType<typeof listChannelMembers>>
  >([]);
  const [serverMembers, setServerMembers] = useState<
    Awaited<ReturnType<typeof listMembers>>
  >([]);
  const [loading, setLoading] = useState(false);
  const [showAddPanel, setShowAddPanel] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    Promise.all([
      listChannelMembers(channelId),
      listMembers(serverId, { limit: 200 }),
    ])
      .then(([chanMembers, srvMembers]) => {
        setMembers(chanMembers);
        setServerMembers(srvMembers);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [open, channelId, serverId]);

  const memberIds = new Set(members.map((m) => m.userId));
  const nonMembers = serverMembers.filter((m) => !memberIds.has(m.userId));

  async function handleAdd(userId: string) {
    try {
      await addChannelMember(channelId, userId);
      const refreshed = await listChannelMembers(channelId);
      setMembers(refreshed);
    } catch {
      // Error handled by API layer
    }
  }

  async function handleRemove(userId: string) {
    try {
      await removeChannelMember(channelId, userId);
      const refreshed = await listChannelMembers(channelId);
      setMembers(refreshed);
    } catch {
      // Error handled by API layer
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/60" />
        <Dialog.Content className="fixed top-1/2 left-1/2 w-full max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-xl bg-bg-elevated p-6 shadow-lg animate-scale-in">
          <Dialog.Title className="text-lg font-semibold text-text">
            Channel Members
          </Dialog.Title>

          {loading ? (
            <div className="mt-4 text-sm text-text-muted">Loading...</div>
          ) : (
            <div className="mt-4 flex flex-col gap-3">
              {/* Current members */}
              <div className="flex flex-col gap-1 max-h-60 overflow-y-auto">
                {members.length === 0 ? (
                  <div className="text-sm text-text-muted">No members</div>
                ) : (
                  members.map((m) => (
                    <div
                      key={m.userId}
                      className="flex items-center justify-between rounded-md px-2 py-1.5"
                    >
                      <span className="text-sm text-text">
                        {m.nickname || m.userId}
                      </span>
                      <button
                        type="button"
                        className="text-xs text-error hover:underline"
                        onClick={() => handleRemove(m.userId)}
                      >
                        Remove
                      </button>
                    </div>
                  ))
                )}
              </div>

              {/* Add member section */}
              {!showAddPanel ? (
                <button
                  type="button"
                  className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-black transition-colors hover:bg-accent-hover"
                  onClick={() => setShowAddPanel(true)}
                >
                  Add Member
                </button>
              ) : (
                <div className="flex flex-col gap-1">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold uppercase tracking-wider text-text-subtle">
                      Add a member
                    </span>
                    <button
                      type="button"
                      className="text-xs text-text-muted hover:text-text"
                      onClick={() => setShowAddPanel(false)}
                    >
                      Cancel
                    </button>
                  </div>
                  <div className="flex flex-col gap-1 max-h-40 overflow-y-auto">
                    {nonMembers.length === 0 ? (
                      <div className="text-xs text-text-muted">
                        All server members are already in this channel
                      </div>
                    ) : (
                      nonMembers.map((m) => (
                        <button
                          key={m.userId}
                          type="button"
                          className="flex items-center justify-between rounded-md px-2 py-1.5 text-sm text-text hover:bg-bg-surface"
                          onClick={() => handleAdd(m.userId)}
                        >
                          <span>{m.nickname || m.userId}</span>
                          <span className="text-xs text-accent">+ Add</span>
                        </button>
                      ))
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="mt-4 flex justify-end">
            <Dialog.Close asChild>
              <button
                type="button"
                className="rounded-md bg-bg-surface px-3 py-1.5 text-sm text-text-muted hover:bg-bg-elevated hover:text-text"
              >
                Close
              </button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
