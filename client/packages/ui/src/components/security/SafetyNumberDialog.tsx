import {
  computeSafetyNumber,
  formatSafetyNumber,
  getIdentity,
  getPublicKeys,
  useAuthStore,
  useUsersStore,
} from '@meza/core';
import { Copy, ShieldCheck, ShieldWarning } from '@phosphor-icons/react';
import * as Dialog from '@radix-ui/react-dialog';
import { useCallback, useEffect, useState } from 'react';
import { useVerificationStore } from '../../stores/verification.ts';

interface SafetyNumberDialogProps {
  userId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type DialogState = 'loading' | 'error' | 'ready';

export function SafetyNumberDialog({
  userId,
  open,
  onOpenChange,
}: SafetyNumberDialogProps) {
  const currentUser = useAuthStore((s) => s.user);
  const profile = useUsersStore((s) => s.profiles[userId]);
  const isVerified = useVerificationStore((s) => s.isVerified(userId));
  const setVerified = useVerificationStore((s) => s.setVerified);
  const clearVerified = useVerificationStore((s) => s.clearVerified);

  const [state, setState] = useState<DialogState>('loading');
  const [safetyNumber, setSafetyNumber] = useState('');
  const [theirKey, setTheirKey] = useState<Uint8Array | null>(null);
  const [copied, setCopied] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  const displayName = profile?.displayName || profile?.username || 'this user';

  const compute = useCallback(async () => {
    setState('loading');
    setErrorMessage('');

    try {
      const identity = getIdentity();
      if (!identity || !currentUser?.id) {
        setErrorMessage('Your encryption session is not ready.');
        setState('error');
        return;
      }

      const keys = await getPublicKeys([userId]);
      const pk = keys[userId];
      if (!pk) {
        setErrorMessage("This user hasn't set up encryption yet.");
        setState('error');
        return;
      }

      setTheirKey(pk);
      const sn = computeSafetyNumber(
        identity.publicKey,
        currentUser.id,
        pk,
        userId,
      );
      setSafetyNumber(sn);
      setState('ready');
    } catch {
      setErrorMessage('Failed to compute safety number.');
      setState('error');
    }
  }, [userId, currentUser?.id]);

  useEffect(() => {
    if (open) {
      compute();
      setCopied(false);
    }
  }, [open, compute]);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(safetyNumber);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleVerify = async () => {
    if (!theirKey) return;
    if (isVerified) {
      await clearVerified(userId);
    } else {
      await setVerified(userId, theirKey);
    }
  };

  const grid = state === 'ready' ? formatSafetyNumber(safetyNumber) : null;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60" />
        <Dialog.Content className="fixed top-1/2 left-1/2 z-50 w-full max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-xl bg-bg-elevated p-6 shadow-lg animate-scale-in">
          <Dialog.Title className="text-lg font-semibold text-text">
            Safety number
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-text-subtle">
            Compare this number with{' '}
            <span className="font-medium text-text">{displayName}</span> in
            person or over a trusted channel. If the numbers match, your
            messages are secure.
          </Dialog.Description>

          {state === 'loading' && (
            <div className="mt-6 flex items-center justify-center py-8">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-accent border-t-transparent" />
            </div>
          )}

          {state === 'error' && (
            <div className="mt-6 rounded-lg bg-bg-surface p-4 text-center text-sm text-text-subtle">
              {errorMessage}
            </div>
          )}

          {state === 'ready' && grid && (
            <>
              <div
                className="mt-5 rounded-lg bg-bg-surface p-4"
                role="group"
                aria-label={`Safety number: ${safetyNumber.match(/.{5}/g)?.join(' ')}`}
              >
                <div className="grid grid-cols-3 gap-x-4 gap-y-2 text-center font-mono text-lg tracking-widest text-text select-all">
                  {grid.flat().map((group: string, i: number) => (
                    <span key={i}>{group}</span>
                  ))}
                </div>
              </div>

              <div className="mt-4 flex gap-2">
                <button
                  type="button"
                  onClick={handleCopy}
                  className="flex flex-1 items-center justify-center gap-2 rounded-md border border-border bg-bg-surface px-3 py-2 text-sm font-medium text-text hover:bg-bg-surface-hover transition-colors"
                >
                  <Copy size={16} />
                  {copied ? 'Copied!' : 'Copy'}
                </button>

                <button
                  type="button"
                  onClick={handleVerify}
                  className={`flex flex-1 items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                    isVerified
                      ? 'border border-border bg-bg-surface text-text-subtle hover:bg-bg-surface-hover'
                      : 'bg-accent text-black hover:bg-accent-hover'
                  }`}
                >
                  {isVerified ? (
                    <>
                      <ShieldCheck size={16} weight="fill" />
                      Verified
                    </>
                  ) : (
                    <>
                      <ShieldWarning size={16} />
                      Mark as Verified
                    </>
                  )}
                </button>
              </div>
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
