import { banMember } from '@meza/core';
import * as Dialog from '@radix-ui/react-dialog';
import { useState } from 'react';

const MAX_REASON_LENGTH = 512;

interface BanMemberDialogProps {
  serverId: string;
  userId: string;
  displayName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function BanMemberDialog({
  serverId,
  userId,
  displayName,
  open,
  onOpenChange,
}: BanMemberDialogProps) {
  const [reason, setReason] = useState('');
  const [submitError, setSubmitError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const guardedOpenChange = (next: boolean) => {
    if (!next && isSubmitting) return;
    if (!next) {
      setReason('');
      setSubmitError('');
    }
    onOpenChange(next);
  };

  async function handleBan() {
    setSubmitError('');
    setIsSubmitting(true);

    try {
      await banMember(serverId, userId, reason.trim() || undefined);
      onOpenChange(false);
      setReason('');
    } catch {
      setSubmitError('Failed to ban member');
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
            Ban Member
          </Dialog.Title>

          <p className="mt-3 text-sm text-text-muted">
            Are you sure you want to ban{' '}
            <strong className="text-text">{displayName}</strong>? They will not
            be able to rejoin until unbanned.
          </p>

          <div className="mt-4">
            <label
              htmlFor="ban-reason"
              className="block text-sm font-medium text-text-muted"
            >
              Reason (optional)
            </label>
            <textarea
              id="ban-reason"
              value={reason}
              onChange={(e) => {
                if (e.target.value.length <= MAX_REASON_LENGTH) {
                  setReason(e.target.value);
                }
              }}
              disabled={isSubmitting}
              rows={3}
              placeholder="Why is this member being banned?"
              className="mt-1 w-full resize-none rounded-md border border-border bg-bg-surface px-3 py-2 text-sm text-text placeholder:text-text-subtle focus:border-accent focus:outline-none disabled:opacity-50"
            />
            <div className="mt-1 text-right text-xs text-text-subtle">
              {reason.length}/{MAX_REASON_LENGTH}
            </div>
          </div>

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
              onClick={handleBan}
              className="rounded-md bg-error px-4 py-2 text-sm font-medium text-white hover:bg-error/80 disabled:opacity-50"
            >
              {isSubmitting ? 'Banning...' : 'Ban'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
