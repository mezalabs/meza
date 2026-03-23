import { deleteChannel } from '@meza/core';
import * as Dialog from '@radix-ui/react-dialog';
import { useState } from 'react';
import { useTilingStore } from '../../stores/tiling.ts';

interface DeleteChannelDialogProps {
  channelId: string;
  channelName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function DeleteChannelDialog({
  channelId,
  channelName,
  open,
  onOpenChange,
}: DeleteChannelDialogProps) {
  const [submitError, setSubmitError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const guardedOpenChange = (next: boolean) => {
    if (!next && isSubmitting) return;
    onOpenChange(next);
  };

  async function handleDelete() {
    setSubmitError('');
    setIsSubmitting(true);

    try {
      await deleteChannel(channelId);

      // Reset any panes showing this channel to empty
      const { panes, setPaneContent } = useTilingStore.getState();
      for (const [paneId, content] of Object.entries(panes)) {
        if (content.type === 'channel' && content.channelId === channelId) {
          setPaneContent(paneId, { type: 'empty' });
        }
      }

      onOpenChange(false);
    } catch {
      setSubmitError('Failed to delete channel');
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
            Delete Channel
          </Dialog.Title>

          <p className="mt-3 text-sm text-text-muted">
            Are you sure you want to delete{' '}
            <strong className="text-text">#{channelName}</strong>? This action
            cannot be undone.
          </p>

          {submitError && (
            <p className="mt-3 text-xs text-error">{submitError}</p>
          )}

          <div className="mt-5 flex justify-end gap-2">
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
              type="button"
              disabled={isSubmitting}
              onClick={handleDelete}
              className="rounded-md bg-error px-4 py-2 text-sm font-medium text-white hover:bg-error/80 disabled:opacity-50"
            >
              {isSubmitting ? 'Deleting...' : 'Delete'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
