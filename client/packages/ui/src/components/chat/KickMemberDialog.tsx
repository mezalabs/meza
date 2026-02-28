import { kickMember } from '@meza/core';
import * as Dialog from '@radix-ui/react-dialog';
import { useState } from 'react';

interface KickMemberDialogProps {
  serverId: string;
  userId: string;
  displayName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function KickMemberDialog({
  serverId,
  userId,
  displayName,
  open,
  onOpenChange,
}: KickMemberDialogProps) {
  const [submitError, setSubmitError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const guardedOpenChange = (next: boolean) => {
    if (!next && isSubmitting) return;
    onOpenChange(next);
  };

  async function handleKick() {
    setSubmitError('');
    setIsSubmitting(true);

    try {
      await kickMember(serverId, userId);
      onOpenChange(false);
    } catch {
      setSubmitError('Failed to kick member');
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
            Kick Member
          </Dialog.Title>

          <p className="mt-3 text-sm text-text-muted">
            Are you sure you want to kick{' '}
            <strong className="text-text">{displayName}</strong>? They will be
            able to rejoin with a new invite.
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
              onClick={handleKick}
              className="rounded-md bg-error px-4 py-2 text-sm font-medium text-white hover:bg-error/80 disabled:opacity-50"
            >
              {isSubmitting ? 'Kicking...' : 'Kick'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
