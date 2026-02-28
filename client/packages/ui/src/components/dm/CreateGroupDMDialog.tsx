import { createGroupDMChannel, useFriendStore } from '@meza/core';
import { CheckIcon } from '@phosphor-icons/react';
import * as Dialog from '@radix-ui/react-dialog';
import { type FormEvent, useMemo, useState } from 'react';
import { useTilingStore } from '../../stores/tiling.ts';
import { Avatar } from '../shared/Avatar.tsx';

interface CreateGroupDMDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CreateGroupDMDialog({
  open,
  onOpenChange,
}: CreateGroupDMDialogProps) {
  const friends = useFriendStore((s) => s.friends);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [name, setName] = useState('');
  const [search, setSearch] = useState('');
  const [submitError, setSubmitError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const filtered = useMemo(() => {
    if (!search) return friends;
    const q = search.toLowerCase();
    return friends.filter(
      (f) =>
        f.username.toLowerCase().includes(q) ||
        f.displayName?.toLowerCase().includes(q),
    );
  }, [friends, search]);

  const guardedOpenChange = (next: boolean) => {
    if (!next && isSubmitting) return;
    if (!next) {
      setSelected(new Set());
      setName('');
      setSearch('');
      setSubmitError('');
    }
    onOpenChange(next);
  };

  function toggleUser(userId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) {
        next.delete(userId);
      } else if (next.size < 9) {
        next.add(userId);
      }
      return next;
    });
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();

    if (selected.size < 2) {
      setSubmitError('Select at least 2 friends');
      return;
    }

    setSubmitError('');
    setIsSubmitting(true);

    try {
      const res = await createGroupDMChannel(
        [...selected],
        name.trim() || undefined,
      );
      if (res.dmChannel?.channel) {
        const { focusedPaneId, setPaneContent } = useTilingStore.getState();
        setPaneContent(focusedPaneId, {
          type: 'dm',
          conversationId: res.dmChannel.channel.id,
        });
        guardedOpenChange(false);
      } else {
        setSubmitError('Failed to create group DM');
      }
    } catch (err) {
      setSubmitError(
        err instanceof Error ? err.message : 'Failed to create group DM',
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={guardedOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/60" />
        <Dialog.Content
          className="fixed top-1/2 left-1/2 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl bg-bg-elevated p-6 shadow-lg animate-scale-in"
          onEscapeKeyDown={(e) => {
            if (isSubmitting) e.preventDefault();
          }}
        >
          <Dialog.Title className="text-lg font-semibold text-text">
            Create Group DM
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-text-muted">
            Select friends to start a group conversation (2-9).
          </Dialog.Description>

          <form onSubmit={handleSubmit} className="mt-4 flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="group-dm-name"
                className="text-xs font-semibold uppercase tracking-wider text-text-subtle"
              >
                Group name (optional)
              </label>
              <input
                id="group-dm-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="My group chat"
                maxLength={100}
                disabled={isSubmitting}
                className="w-full rounded-md border border-border bg-bg-surface px-3 py-2 text-sm text-text placeholder:text-text-muted focus:border-accent focus:outline-none disabled:opacity-50"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="group-dm-search"
                className="text-xs font-semibold uppercase tracking-wider text-text-subtle"
              >
                Friends ({selected.size}/9 selected)
              </label>
              <input
                id="group-dm-search"
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search friends..."
                disabled={isSubmitting}
                className="w-full rounded-md border border-border bg-bg-surface px-3 py-2 text-sm text-text placeholder:text-text-muted focus:border-accent focus:outline-none disabled:opacity-50"
              />
            </div>

            <div className="flex max-h-48 flex-col gap-0.5 overflow-y-auto rounded-md border border-border bg-bg-surface p-1">
              {filtered.length === 0 ? (
                <div className="px-2 py-3 text-center text-sm text-text-muted">
                  {friends.length === 0
                    ? 'No friends yet'
                    : 'No friends match your search'}
                </div>
              ) : (
                filtered.map((friend) => {
                  const isSelected = selected.has(friend.id);
                  return (
                    <button
                      key={friend.id}
                      type="button"
                      disabled={
                        isSubmitting || (!isSelected && selected.size >= 9)
                      }
                      onClick={() => toggleUser(friend.id)}
                      className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors ${
                        isSelected
                          ? 'bg-accent-subtle text-text'
                          : 'text-text-muted hover:bg-bg-tertiary hover:text-text disabled:opacity-40'
                      }`}
                    >
                      <Avatar
                        avatarUrl={friend.avatarUrl}
                        displayName={friend.displayName || friend.username}
                        size="sm"
                      />
                      <span className="flex-1 truncate text-left">
                        {friend.displayName || friend.username}
                      </span>
                      {isSelected && (
                        <CheckIcon size={16} className="text-accent" aria-hidden="true" />
                      )}
                    </button>
                  );
                })
              )}
            </div>

            {submitError && <p className="text-xs text-error">{submitError}</p>}

            <div className="flex justify-end gap-2">
              <Dialog.Close asChild>
                <button
                  type="button"
                  disabled={isSubmitting}
                  className="rounded-md bg-bg-surface px-3 py-1.5 text-sm text-text-muted hover:bg-bg-elevated hover:text-text disabled:opacity-50"
                >
                  Cancel
                </button>
              </Dialog.Close>
              <button
                type="submit"
                disabled={isSubmitting || selected.size < 2}
                className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-black transition-colors hover:bg-accent-hover disabled:opacity-50"
              >
                {isSubmitting ? 'Creating...' : 'Create'}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
