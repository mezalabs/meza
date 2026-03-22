import * as Dialog from '@radix-ui/react-dialog';
import { CheckIcon, CopyIcon, WarningIcon } from '@phosphor-icons/react';
import { useCallback, useRef, useState } from 'react';

/** Encode bytes to base64 for display. */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

interface BotTokenModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  token: string;
  privateKey?: Uint8Array;
  botName: string;
}

export function BotTokenModal({
  open,
  onOpenChange,
  token,
  privateKey,
  botName,
}: BotTokenModalProps) {
  const [saved, setSaved] = useState(false);
  const [copiedToken, setCopiedToken] = useState(false);
  const [copiedKey, setCopiedKey] = useState(false);
  const [showConfirmClose, setShowConfirmClose] = useState(false);
  const privateKeyBase64 = useRef(
    privateKey ? bytesToBase64(privateKey) : null,
  ).current;

  const handleCopyToken = async () => {
    try {
      await navigator.clipboard.writeText(token);
      setCopiedToken(true);
      setTimeout(() => setCopiedToken(false), 2000);
    } catch {}
  };

  const handleCopyKey = async () => {
    if (!privateKeyBase64) return;
    try {
      await navigator.clipboard.writeText(privateKeyBase64);
      setCopiedKey(true);
      setTimeout(() => setCopiedKey(false), 2000);
    } catch {}
  };

  const handleClose = useCallback(() => {
    if (!saved) {
      setShowConfirmClose(true);
      return;
    }
    onOpenChange(false);
  }, [saved, onOpenChange]);

  const handleInteractOutside = useCallback(
    (e: Event) => {
      if (!saved) {
        e.preventDefault();
        setShowConfirmClose(true);
      }
    },
    [saved],
  );

  const handleEscapeKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!saved) {
        e.preventDefault();
        setShowConfirmClose(true);
      }
    },
    [saved],
  );

  return (
    <>
      <Dialog.Root open={open} onOpenChange={handleClose}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-black/60 animate-fade-in" />
          <Dialog.Content
            className="fixed left-1/2 top-1/2 w-full max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-lg bg-bg-elevated p-6 shadow-lg animate-scale-in"
            onInteractOutside={handleInteractOutside}
            onEscapeKeyDown={handleEscapeKeyDown}
          >
            <Dialog.Title className="text-lg font-semibold text-text">
              {privateKeyBase64 ? 'Bot Created' : 'Token Regenerated'}: {botName}
            </Dialog.Title>

            <div className="mt-3 flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 p-3">
              <WarningIcon
                size={18}
                className="mt-0.5 flex-shrink-0 text-warning"
                aria-hidden="true"
              />
              <p className="text-sm text-warning">
                Save these credentials now. They will not be shown again.
              </p>
            </div>

            <div className="mt-4 space-y-4">
              {/* Token */}
              <div>
                <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-text-subtle">
                  Bot Token
                </label>
                <div className="flex items-center gap-2">
                  <code className="flex-1 truncate rounded-md border border-border bg-bg-surface px-3 py-2 font-mono text-xs text-text select-all">
                    {token}
                  </code>
                  <button
                    type="button"
                    onClick={handleCopyToken}
                    className="flex-shrink-0 rounded-md bg-bg-surface p-2 text-text-muted hover:text-text transition-colors"
                    aria-label="Copy token"
                  >
                    {copiedToken ? (
                      <CheckIcon size={16} aria-hidden="true" />
                    ) : (
                      <CopyIcon size={16} aria-hidden="true" />
                    )}
                  </button>
                </div>
              </div>

              {/* Private Key (only shown on creation, not on regenerate) */}
              {privateKeyBase64 && (
                <div>
                  <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-text-subtle">
                    Private Key (Ed25519)
                  </label>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 truncate rounded-md border border-border bg-bg-surface px-3 py-2 font-mono text-xs text-text select-all">
                      {privateKeyBase64}
                    </code>
                    <button
                      type="button"
                      onClick={handleCopyKey}
                      className="flex-shrink-0 rounded-md bg-bg-surface p-2 text-text-muted hover:text-text transition-colors"
                      aria-label="Copy private key"
                    >
                      {copiedKey ? (
                        <CheckIcon size={16} aria-hidden="true" />
                      ) : (
                        <CopyIcon size={16} aria-hidden="true" />
                      )}
                    </button>
                  </div>
                </div>
              )}
            </div>

            <div className="mt-5 flex items-center justify-between">
              <label className="flex items-center gap-2 text-sm text-text-muted cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={saved}
                  onChange={(e) => setSaved(e.target.checked)}
                  className="h-4 w-4 rounded border-border accent-accent"
                />
                I've saved my credentials
              </label>
              <button
                type="button"
                disabled={!saved}
                onClick={() => onOpenChange(false)}
                className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-black hover:bg-accent-hover disabled:opacity-50"
              >
                Done
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {/* Confirmation dialog when trying to close without saving */}
      <Dialog.Root open={showConfirmClose} onOpenChange={setShowConfirmClose}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-[60] bg-black/60 animate-fade-in" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-[60] w-full max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-lg bg-bg-elevated p-6 shadow-lg animate-scale-in">
            <Dialog.Title className="text-lg font-semibold text-text">
              Close without saving?
            </Dialog.Title>
            <Dialog.Description className="mt-2 text-sm text-text-muted">
              You haven't confirmed that you've saved your bot credentials.
              If you close now, you will lose access to the token and private
              key forever.
            </Dialog.Description>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowConfirmClose(false)}
                className="rounded-md bg-bg-surface px-3 py-1.5 text-sm text-text-muted hover:bg-bg-elevated hover:text-text"
              >
                Go Back
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowConfirmClose(false);
                  onOpenChange(false);
                }}
                className="rounded-md bg-danger px-3 py-1.5 text-sm font-medium text-white hover:bg-danger/80"
              >
                Close Anyway
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
