import { updateChannel, useChannelStore } from '@meza/core';
import * as Dialog from '@radix-ui/react-dialog';
import { type FormEvent, useEffect, useState } from 'react';

interface EditChannelDialogProps {
  channelId: string;
  currentName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function normalizeName(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');
}

export function EditChannelDialog({
  channelId,
  currentName,
  open,
  onOpenChange,
}: EditChannelDialogProps) {
  const [name, setName] = useState(currentName);
  const [topic, setTopic] = useState('');
  const [submitError, setSubmitError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Load current topic from store when dialog opens
  useEffect(() => {
    if (open) {
      setName(currentName);
      setSubmitError('');
      const state = useChannelStore.getState();
      for (const channels of Object.values(state.byServer)) {
        const channel = channels.find((c) => c.id === channelId);
        if (channel) {
          setTopic(channel.topic ?? '');
          break;
        }
      }
    }
  }, [open, channelId, currentName]);

  const guardedOpenChange = (next: boolean) => {
    if (!next && isSubmitting) return;
    onOpenChange(next);
  };

  const hasChanges =
    name !== currentName ||
    (() => {
      const state = useChannelStore.getState();
      for (const channels of Object.values(state.byServer)) {
        const channel = channels.find((c) => c.id === channelId);
        if (channel) return topic !== (channel.topic ?? '');
      }
      return topic !== '';
    })();

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();

    if (name.length === 0) return;

    setSubmitError('');
    setIsSubmitting(true);

    try {
      const updates: { name?: string; topic?: string } = {};

      if (name !== currentName) {
        updates.name = name;
      }

      // Check if topic changed
      const state = useChannelStore.getState();
      let currentTopic = '';
      for (const channels of Object.values(state.byServer)) {
        const channel = channels.find((c) => c.id === channelId);
        if (channel) {
          currentTopic = channel.topic ?? '';
          break;
        }
      }
      if (topic !== currentTopic) {
        updates.topic = topic;
      }

      if (Object.keys(updates).length > 0) {
        await updateChannel(channelId, updates);
      }
      onOpenChange(false);
    } catch {
      setSubmitError('Failed to update channel');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={guardedOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60" />
        <Dialog.Content
          className="fixed top-1/2 left-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl bg-bg-elevated p-6 shadow-lg animate-scale-in"
          onEscapeKeyDown={(e) => {
            if (isSubmitting) e.preventDefault();
          }}
        >
          <Dialog.Title className="text-lg font-semibold text-text">
            Edit Channel
          </Dialog.Title>

          <form onSubmit={handleSubmit} className="mt-4 flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="edit-channel-name"
                className="text-xs font-semibold uppercase tracking-wider text-text-subtle"
              >
                Channel name
              </label>
              <input
                id="edit-channel-name"
                type="text"
                value={name}
                onChange={(e) => setName(normalizeName(e.target.value))}
                placeholder="channel-name"
                maxLength={100}
                disabled={isSubmitting}
                className="w-full rounded-md border border-border bg-bg-surface px-3 py-2 text-sm text-text placeholder:text-text-muted focus:border-accent focus:outline-none disabled:opacity-50"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="edit-channel-topic"
                className="text-xs font-semibold uppercase tracking-wider text-text-subtle"
              >
                Topic
              </label>
              <textarea
                id="edit-channel-topic"
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                placeholder="Set a topic"
                maxLength={1024}
                rows={3}
                disabled={isSubmitting}
                className="w-full resize-none rounded-md border border-border bg-bg-surface px-3 py-2 text-sm text-text placeholder:text-text-muted focus:border-accent focus:outline-none disabled:opacity-50"
              />
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
                disabled={isSubmitting || !hasChanges || name.length === 0}
                className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-black transition-colors hover:bg-accent-hover disabled:opacity-50"
              >
                {isSubmitting ? 'Saving...' : 'Save'}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
