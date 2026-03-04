import { joinServer, resolveInvite, useInviteStore } from '@meza/core';
import * as Dialog from '@radix-ui/react-dialog';
import { type FormEvent, useEffect, useState } from 'react';
import { useNavigationStore } from '../../stores/navigation.ts';
import { useTilingStore } from '../../stores/tiling.ts';

/** Extract the 8-char invite code from any input: full URL, URL with fragment, or bare code. */
function extractInviteCode(input: string): string {
  const trimmed = input.trim();
  // Try to match an invite code from a URL like https://example.com/invite/abc12345#fragment
  const match = trimmed.match(/\/invite\/([a-z0-9]{8})/i);
  if (match) return match[1].toLowerCase();
  // Strip any fragment or query from a bare code
  return trimmed.split(/[#?]/)[0].toLowerCase();
}

interface ServerPreview {
  name: string;
  memberCount: number;
}

export function JoinServerDialog({
  open,
  onOpenChange,
  initialCode,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialCode?: string;
}) {
  const [code, setCode] = useState('');
  const [preview, setPreview] = useState<ServerPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setCode('');
    setPreview(null);
    setError(null);
    setLoading(false);
  };

  const handleOpenChange = (next: boolean) => {
    if (!next) {
      useInviteStore.getState().clearPendingCode();
      reset();
    }
    onOpenChange(next);
  };

  // Auto-resolve when opened with an initialCode from an invite link
  useEffect(() => {
    if (!open || !initialCode) return;
    setCode(initialCode);
    setLoading(true);
    setError(null);
    resolveInvite(initialCode)
      .then((res) => {
        if (res.server) {
          setPreview({ name: res.server.name, memberCount: res.memberCount });
        }
      })
      .catch((err) => {
        setError(
          err instanceof Error ? err.message : 'Invalid or expired invite code',
        );
        useInviteStore.getState().clearPendingCode();
      })
      .finally(() => setLoading(false));
  }, [open, initialCode]);

  const handlePreview = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = extractInviteCode(code);
    if (!trimmed) return;

    setLoading(true);
    setError(null);
    try {
      const res = await resolveInvite(trimmed);
      if (res.server) {
        setPreview({ name: res.server.name, memberCount: res.memberCount });
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Invalid or expired invite code',
      );
    } finally {
      setLoading(false);
    }
  };

  const handleJoin = async () => {
    setLoading(true);
    setError(null);
    try {
      const server = await joinServer(extractInviteCode(code));
      useInviteStore.getState().clearPendingCode();
      if (server) {
        useNavigationStore.getState().selectServer(server.id);
        if (server.onboardingEnabled) {
          const { focusedPaneId, setPaneContent } = useTilingStore.getState();
          setPaneContent(focusedPaneId, {
            type: 'serverOnboarding',
            serverId: server.id,
          });
        }
      }
      handleOpenChange(false);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to join server';
      // "Already a member" — navigate to server instead of showing error
      if (message.toLowerCase().includes('already')) {
        useInviteStore.getState().clearPendingCode();
        handleOpenChange(false);
      } else {
        setError(message);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/60 animate-fade-in" />
        <Dialog.Content className="fixed left-1/2 top-1/2 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg bg-bg-elevated p-6 shadow-lg animate-scale-in">
          <Dialog.Title className="text-lg font-semibold text-text">
            Join a Server
          </Dialog.Title>

          {!preview ? (
            <form onSubmit={handlePreview} className="mt-4 space-y-4">
              <div>
                <label
                  htmlFor="invite-code"
                  className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-text-subtle"
                >
                  Invite Code
                </label>
                <input
                  id="invite-code"
                  type="text"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="Enter an invite code (e.g. abc12345)"
                  required
                  disabled={loading}
                  className="w-full rounded-md border border-border bg-bg-surface px-3 py-2 text-sm text-text placeholder:text-text-muted focus:border-accent focus:outline-none disabled:opacity-50"
                />
              </div>

              {error && <p className="text-xs text-error">{error}</p>}

              <div className="flex justify-end gap-2">
                <Dialog.Close asChild>
                  <button
                    type="button"
                    disabled={loading}
                    className="rounded-md bg-bg-surface px-3 py-1.5 text-sm text-text-muted hover:bg-bg-elevated hover:text-text"
                  >
                    Cancel
                  </button>
                </Dialog.Close>
                <button
                  type="submit"
                  disabled={loading || !code.trim()}
                  className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-black hover:bg-accent-hover disabled:opacity-50"
                >
                  {loading ? 'Looking up...' : 'Preview'}
                </button>
              </div>
            </form>
          ) : (
            <div className="mt-4 space-y-4">
              <div className="rounded-md border border-border bg-bg-surface p-4">
                <div className="flex items-center gap-3">
                  <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-accent text-lg font-bold text-black">
                    {preview.name.charAt(0).toUpperCase()}
                  </div>
                  <div>
                    <div className="text-sm font-semibold text-text">
                      {preview.name}
                    </div>
                    <div className="text-xs text-text-muted">
                      {preview.memberCount}{' '}
                      {preview.memberCount === 1 ? 'member' : 'members'}
                    </div>
                  </div>
                </div>
              </div>

              {error && <p className="text-xs text-error">{error}</p>}

              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setPreview(null);
                    setError(null);
                  }}
                  disabled={loading}
                  className="rounded-md bg-bg-surface px-3 py-1.5 text-sm text-text-muted hover:bg-bg-elevated hover:text-text"
                >
                  Back
                </button>
                <button
                  type="button"
                  onClick={handleJoin}
                  disabled={loading}
                  className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-black hover:bg-accent-hover disabled:opacity-50"
                >
                  {loading ? 'Joining...' : 'Join Server'}
                </button>
              </div>
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
