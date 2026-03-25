import { deleteMessage } from '@meza/core';
import * as Dialog from '@radix-ui/react-dialog';
import { useState } from 'react';

interface DeleteMessageDialogProps {
  channelId: string;
  messageId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function DeleteMessageDialog({
  channelId,
  messageId,
  open,
  onOpenChange,
}: DeleteMessageDialogProps) {
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState('');

  const guardedOpenChange = (next: boolean) => {
    if (!next && isDeleting) return;
    onOpenChange(next);
  };

  async function handleDelete() {
    setIsDeleting(true);
    setError('');
    try {
      await deleteMessage(channelId, messageId);
      onOpenChange(false);
    } catch {
      setError('Failed to delete message');
    } finally {
      setIsDeleting(false);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={guardedOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 animate-fade-in" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-50 w-full max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-xl bg-bg-elevated p-6 shadow-lg animate-scale-in"
          onEscapeKeyDown={(e) => {
            if (isDeleting) e.preventDefault();
          }}
        >
          <Dialog.Title className="text-lg font-semibold text-text">
            Delete Message
          </Dialog.Title>
          <p className="mt-2 text-sm text-text-muted">
            Are you sure you want to delete this message? This action cannot be
            undone.
          </p>

          {error && <p className="mt-2 text-xs text-error">{error}</p>}

          <div className="mt-4 flex justify-end gap-2">
            <Dialog.Close asChild>
              <button
                type="button"
                disabled={isDeleting}
                className="rounded-md bg-bg-surface px-3 py-1.5 text-sm text-text-muted hover:bg-bg-elevated hover:text-text disabled:opacity-50"
              >
                Cancel
              </button>
            </Dialog.Close>
            <button
              type="button"
              disabled={isDeleting}
              onClick={handleDelete}
              className="rounded-md bg-error px-4 py-2 text-sm font-medium text-white hover:bg-error/80 disabled:opacity-50"
            >
              {isDeleting ? 'Deleting...' : 'Delete'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
