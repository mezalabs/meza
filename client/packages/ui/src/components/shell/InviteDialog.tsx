import {
  createInvite,
  createInviteKeyBundle,
  isSessionReady,
  useChannelStore,
} from '@meza/core';
import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useState } from 'react';

type InviteResult = Awaited<ReturnType<typeof createInvite>>;

/** Encode bytes to base64url (no padding). */
function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

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
  const [inviteUrl, setInviteUrl] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) {
      setInvite(undefined);
      setInviteUrl('');
      setError(null);
      setCopied(false);
      return;
    }

    setLoading(true);
    setError(null);

    (async () => {
      try {
        // Generate invite secret and encrypt key bundle if E2EE session is ready
        let keyBundle:
          | { encryptedChannelKeys: Uint8Array; channelKeysIv: Uint8Array }
          | undefined;
        let inviteSecret: Uint8Array | undefined;

        if (isSessionReady()) {
          const channels = useChannelStore.getState().byServer[serverId] ?? [];
          const channelIds = channels.map((ch) => ch.id);
          if (channelIds.length > 0) {
            inviteSecret = crypto.getRandomValues(new Uint8Array(32));
            const { ciphertext, iv } = await createInviteKeyBundle(
              inviteSecret,
              channelIds,
            );
            keyBundle = { encryptedChannelKeys: ciphertext, channelKeysIv: iv };
          }
        }

        const inv = await createInvite(serverId, keyBundle);
        setInvite(inv);

        // Build URL with optional fragment containing the invite secret
        const base = `${window.location.origin}/invite/${inv?.code}`;
        const url = inviteSecret
          ? `${base}#${bytesToBase64Url(inviteSecret)}`
          : base;
        setInviteUrl(url);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : 'Failed to create invite',
        );
      } finally {
        setLoading(false);
      }
    })();
  }, [open, serverId]);

  const handleCopy = async () => {
    if (!inviteUrl) return;
    try {
      await navigator.clipboard.writeText(inviteUrl);
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

            {invite && inviteUrl && (
              <div className="flex items-center gap-2">
                <div
                  className="flex-1 truncate rounded-md border border-border bg-bg-surface px-3 py-2 font-mono text-sm text-text select-all"
                  title={inviteUrl}
                >
                  {inviteUrl}
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
