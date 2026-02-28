import { createInvite } from '@meza/core';
import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useState } from 'react';

type InviteResult = Awaited<ReturnType<typeof createInvite>>;

export function InviteDialog({
  open,
  onOpenChange,
  serverId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  serverId: string;
}) {
  const [invite, setInvite] = useState<InviteResult>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) {
      setInvite(undefined);
      setError(null);
      setCopied(false);
      return;
    }

    setLoading(true);
    setError(null);
    createInvite(serverId)
      .then((inv) => setInvite(inv))
      .catch((err) => {
        setError(
          err instanceof Error ? err.message : 'Failed to create invite',
        );
      })
      .finally(() => setLoading(false));
  }, [open, serverId]);

  const handleCopy = async () => {
    if (!invite) return;
    try {
      await navigator.clipboard.writeText(
        `${window.location.origin}/invite/${invite.code}`,
      );
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/60 animate-fade-in" />
        <Dialog.Content className="fixed left-1/2 top-1/2 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg bg-bg-elevated p-6 shadow-lg animate-scale-in">
          <Dialog.Title className="text-lg font-semibold text-text">
            Invite People
          </Dialog.Title>

          <p className="mt-1 text-sm text-text-muted">
            Share this invite link with others to let them join your server.
          </p>

          <div className="mt-4">
            {loading && (
              <div className="rounded-md border border-border bg-bg-surface px-3 py-2 text-sm text-text-muted">
                Generating invite...
              </div>
            )}

            {error && <p className="text-xs text-error">{error}</p>}

            {invite && (
              <div className="flex items-center gap-2">
                <div
                  className="flex-1 truncate rounded-md border border-border bg-bg-surface px-3 py-2 font-mono text-sm text-text select-all"
                  title={`${window.location.origin}/invite/${invite.code}`}
                >
                  {`${window.location.origin}/invite/${invite.code}`}
                </div>
                <button
                  type="button"
                  onClick={handleCopy}
                  className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-black hover:bg-accent-hover disabled:opacity-50"
                >
                  {copied ? 'Copied!' : 'Copy'}
                </button>
              </div>
            )}
          </div>

          <div className="mt-4 flex justify-end">
            <Dialog.Close asChild>
              <button
                type="button"
                className="rounded-md bg-bg-surface px-3 py-1.5 text-sm text-text-muted hover:bg-bg-elevated hover:text-text"
              >
                Done
              </button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
