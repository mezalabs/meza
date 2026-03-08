import {
  type FederationJoinResult,
  isFederatedInvite,
  joinSatelliteGuild,
} from '@meza/core';
import * as Dialog from '@radix-ui/react-dialog';
import { useState } from 'react';
import { useNavigationStore } from '../../stores/navigation.ts';

type Step = 'input' | 'confirm' | 'joining' | 'success' | 'error';

interface ParsedInvite {
  url: string;
  host: string;
}

export function FederationJoinDialog({
  open,
  onOpenChange,
  initialUrl,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialUrl?: string;
}) {
  const [inviteUrl, setInviteUrl] = useState(initialUrl ?? '');
  const [step, setStep] = useState<Step>('input');
  const [parsed, setParsed] = useState<ParsedInvite | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<FederationJoinResult | null>(null);

  const reset = () => {
    setInviteUrl(initialUrl ?? '');
    setStep('input');
    setParsed(null);
    setError(null);
    setResult(null);
  };

  const handleOpenChange = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };

  const handlePreview = () => {
    const trimmed = inviteUrl.trim();
    if (!trimmed) return;

    try {
      const url = new URL(trimmed);
      if (!isFederatedInvite(trimmed)) {
        setError(
          'This invite points to your home server. Use the regular join dialog instead.',
        );
        return;
      }
      setParsed({ url: trimmed, host: url.hostname });
      setStep('confirm');
      setError(null);
    } catch {
      setError('Please enter a valid invite URL (e.g. https://example.org/invite/ABCD1234)');
    }
  };

  const handleJoin = async () => {
    if (!parsed) return;
    setStep('joining');
    setError(null);

    try {
      const joinResult = await joinSatelliteGuild(parsed.url);
      setResult(joinResult);
      setStep('success');
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to join federated guild',
      );
      setStep('error');
    }
  };

  const handleNavigateToGuild = () => {
    if (result) {
      useNavigationStore.getState().selectServer(result.serverId);
    }
    handleOpenChange(false);
  };

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/60 animate-fade-in" />
        <Dialog.Content className="fixed left-1/2 top-1/2 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg bg-bg-elevated p-6 shadow-lg animate-scale-in">
          <Dialog.Title className="text-lg font-semibold text-text">
            {step === 'success'
              ? 'Joined Successfully'
              : 'Join a Federated Server'}
          </Dialog.Title>

          {/* Step 1: Input invite URL */}
          {step === 'input' && (
            <div className="mt-4 space-y-4">
              <div>
                <label
                  htmlFor="federation-invite-url"
                  className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-text-subtle"
                >
                  Invite URL
                </label>
                <input
                  id="federation-invite-url"
                  type="url"
                  value={inviteUrl}
                  onChange={(e) => {
                    setInviteUrl(e.target.value);
                    setError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      handlePreview();
                    }
                  }}
                  placeholder="https://example.org/invite/ABCD1234"
                  className="w-full rounded-md border border-border bg-bg-surface px-3 py-2 text-sm text-text placeholder:text-text-muted focus:border-accent focus:outline-none"
                />
              </div>

              <p className="text-xs text-text-muted">
                Paste an invite link from another Meza instance to join their
                server through federation.
              </p>

              {error && <p className="text-xs text-error">{error}</p>}

              <div className="flex justify-end gap-2">
                <Dialog.Close asChild>
                  <button
                    type="button"
                    className="rounded-md bg-bg-surface px-3 py-1.5 text-sm text-text-muted hover:bg-bg-elevated hover:text-text"
                  >
                    Cancel
                  </button>
                </Dialog.Close>
                <button
                  type="button"
                  onClick={handlePreview}
                  disabled={!inviteUrl.trim()}
                  className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-black hover:bg-accent-hover disabled:opacity-50"
                >
                  Continue
                </button>
              </div>
            </div>
          )}

          {/* Step 2: Confirm federation join */}
          {step === 'confirm' && parsed && (
            <div className="mt-4 space-y-4">
              <div className="rounded-md border border-border bg-bg-surface p-4">
                <div className="flex items-center gap-3">
                  <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-accent/20 text-lg font-bold text-accent">
                    F
                  </div>
                  <div>
                    <div className="text-sm font-semibold text-text">
                      Federated Server
                    </div>
                    <div className="text-xs text-text-muted">
                      {parsed.host}
                    </div>
                  </div>
                </div>
              </div>

              <div className="rounded-md border border-warning/30 bg-warning/5 p-3">
                <p className="text-xs text-warning">
                  You are about to join a server on a different Meza instance (
                  <strong>{parsed.host}</strong>). Your display name and avatar
                  will be shared with this instance.
                </p>
              </div>

              {error && <p className="text-xs text-error">{error}</p>}

              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setStep('input');
                    setError(null);
                  }}
                  className="rounded-md bg-bg-surface px-3 py-1.5 text-sm text-text-muted hover:bg-bg-elevated hover:text-text"
                >
                  Back
                </button>
                <button
                  type="button"
                  onClick={handleJoin}
                  className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-black hover:bg-accent-hover"
                >
                  Join Server
                </button>
              </div>
            </div>
          )}

          {/* Step 3: Joining in progress */}
          {step === 'joining' && (
            <div className="mt-4 space-y-4">
              <div className="flex flex-col items-center gap-3 py-6">
                <div className="h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" />
                <p className="text-sm text-text-muted">
                  Joining federated server...
                </p>
                <p className="text-xs text-text-muted">
                  Authenticating with {parsed?.host}
                </p>
              </div>
            </div>
          )}

          {/* Step 4: Success */}
          {step === 'success' && result && (
            <div className="mt-4 space-y-4">
              <div className="rounded-md border border-border bg-bg-surface p-4">
                <div className="flex items-center gap-3">
                  <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-accent text-lg font-bold text-black">
                    {result.serverName.charAt(0).toUpperCase()}
                  </div>
                  <div>
                    <div className="text-sm font-semibold text-text">
                      {result.serverName}
                    </div>
                    <div className="text-xs text-text-muted">
                      on {new URL(result.instanceUrl).hostname}
                    </div>
                  </div>
                </div>
              </div>

              <p className="text-center text-sm text-text-muted">
                You have joined the server via federation.
              </p>

              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={handleNavigateToGuild}
                  className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-black hover:bg-accent-hover"
                >
                  Go to Server
                </button>
              </div>
            </div>
          )}

          {/* Step 5: Error */}
          {step === 'error' && (
            <div className="mt-4 space-y-4">
              <div className="rounded-md border border-error/30 bg-error/5 p-3">
                <p className="text-xs text-error">
                  {error || 'An error occurred while joining the server.'}
                </p>
              </div>

              <div className="flex justify-end gap-2">
                <Dialog.Close asChild>
                  <button
                    type="button"
                    className="rounded-md bg-bg-surface px-3 py-1.5 text-sm text-text-muted hover:bg-bg-elevated hover:text-text"
                  >
                    Close
                  </button>
                </Dialog.Close>
                <button
                  type="button"
                  onClick={() => {
                    setStep('confirm');
                    setError(null);
                  }}
                  className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-black hover:bg-accent-hover"
                >
                  Try Again
                </button>
              </div>
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
