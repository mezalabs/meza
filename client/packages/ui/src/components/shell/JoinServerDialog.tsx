import {
  connectSpoke,
  createFederationAssertion,
  federationJoin,
  getBaseUrl,
  joinServer,
  mapFederationError,
  resolveInvite,
  resolveRemoteInvite,
  resolveSpokeInvitePreview,
  useFederationStore,
  useInviteStore,
  validateFederationUrl,
} from '@meza/core';
import * as Dialog from '@radix-ui/react-dialog';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { useNavigationStore } from '../../stores/navigation.ts';
import { useTilingStore } from '../../stores/tiling.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract the 8-char invite code from any input: full URL, URL with fragment, or bare code. */
function extractInviteCode(input: string): string {
  const trimmed = input.trim();
  const match = trimmed.match(/\/invite\/([a-z0-9]{8})/i);
  if (match) return match[1].toLowerCase();
  return trimmed.split(/[#?]/)[0].toLowerCase();
}

type InviteClassification =
  | { type: 'local'; code: string }
  | { type: 'remote'; url: string }
  | null;

/** Classify input as a local invite code or a remote federation URL. */
function classifyInviteInput(input: string): InviteClassification {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // Try to parse as a URL
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      // Not a URL — treat as bare code
      return { type: 'local', code: extractInviteCode(trimmed) };
    }
    // Compare against our own origin
    const base = getBaseUrl();
    const ownOrigin = base ? new URL(base).origin : location.origin;
    if (url.origin === ownOrigin) {
      return { type: 'local', code: extractInviteCode(trimmed) };
    }
    return { type: 'remote', url: trimmed };
  } catch {
    // Not a valid URL — treat as a bare invite code
    return { type: 'local', code: extractInviteCode(trimmed) };
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ServerPreview {
  name: string;
  memberCount: number;
}

interface RemotePreview {
  instanceUrl: string;
  inviteCode: string;
  serverName?: string;
  memberCount?: number;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

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
  const [remotePreview, setRemotePreview] = useState<RemotePreview | null>(
    null,
  );
  const [loading, setLoading] = useState(false);
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const reset = () => {
    setCode('');
    setPreview(null);
    setRemotePreview(null);
    setError(null);
    setLoading(false);
    setJoining(false);
    abortRef.current?.abort();
    abortRef.current = null;
  };

  const handleOpenChange = (next: boolean) => {
    if (joining) return; // Prevent close while join is in-flight
    if (!next) {
      useInviteStore.getState().clearPendingCode();
      reset();
    }
    onOpenChange(next);
  };

  // Clean up abort controller on unmount
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

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
    const classification = classifyInviteInput(code);
    if (!classification) return;

    setLoading(true);
    setError(null);

    if (classification.type === 'local') {
      try {
        const res = await resolveInvite(classification.code);
        if (res.server) {
          setPreview({
            name: res.server.name,
            memberCount: res.memberCount,
          });
        }
      } catch (err) {
        setError(
          err instanceof Error ? err.message : 'Invalid or expired invite code',
        );
      } finally {
        setLoading(false);
      }
    } else {
      // Remote federation URL
      try {
        validateFederationUrl(classification.url);

        // Check if already connected to this spoke
        const spokes = useFederationStore.getState().spokes;
        for (const spoke of Object.values(spokes)) {
          if (
            classification.url.startsWith(spoke.instanceUrl) &&
            spoke.status === 'connected'
          ) {
            useNavigationStore.getState().selectServer(spoke.serverId);
            handleOpenChange(false);
            return;
          }
        }

        // Resolve the remote invite
        const { instanceUrl, inviteCode } = await resolveRemoteInvite(
          classification.url,
        );

        // Try to get server preview from the spoke
        const spokePreview = await resolveSpokeInvitePreview(
          instanceUrl,
          inviteCode,
        );

        setRemotePreview({
          instanceUrl,
          inviteCode,
          serverName: spokePreview?.name,
          memberCount: spokePreview?.memberCount,
        });
      } catch (err) {
        setError(mapFederationError(err));
      } finally {
        setLoading(false);
      }
    }
  };

  const handleJoin = async () => {
    setJoining(true);
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
      if (message.toLowerCase().includes('already')) {
        useInviteStore.getState().clearPendingCode();
        handleOpenChange(false);
      } else {
        setError(message);
      }
    } finally {
      setJoining(false);
    }
  };

  const handleRemoteJoin = async () => {
    if (!remotePreview) return;
    const { instanceUrl, inviteCode } = remotePreview;

    const controller = new AbortController();
    abortRef.current = controller;
    setJoining(true);
    setError(null);

    try {
      // Step 1: Get assertion from origin
      const assertionToken = await createFederationAssertion(instanceUrl);
      if (controller.signal.aborted) return;

      // Step 2: Join the spoke
      const { serverId } = await federationJoin(
        instanceUrl,
        assertionToken,
        inviteCode,
      );
      if (controller.signal.aborted) {
        // Join succeeded but dialog was closed — don't navigate.
        // The spoke tokens are stored so the connection can resume.
        return;
      }

      // Step 3: Connect spoke gateway
      connectSpoke(instanceUrl);

      // Step 4: Navigate to the new server
      if (serverId) {
        useNavigationStore.getState().selectServer(serverId);
      }
      handleOpenChange(false);
    } catch (err) {
      if (controller.signal.aborted) return;
      const message = mapFederationError(err);
      // "Already a member" — navigate to the server
      if (message.toLowerCase().includes('already')) {
        const spoke = useFederationStore.getState().spokes[instanceUrl];
        if (spoke?.serverId) {
          useNavigationStore.getState().selectServer(spoke.serverId);
        }
        handleOpenChange(false);
      } else {
        setError(message);
      }
    } finally {
      setJoining(false);
      abortRef.current = null;
    }
  };

  const hasPreview = !!preview || !!remotePreview;

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 animate-fade-in" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg bg-bg-elevated p-6 shadow-lg animate-scale-in"
          onEscapeKeyDown={(e) => {
            if (joining) e.preventDefault();
          }}
          onPointerDownOutside={(e) => {
            if (joining) e.preventDefault();
          }}
        >
          <Dialog.Title className="text-lg font-semibold text-text">
            Join a Server
          </Dialog.Title>

          {!hasPreview ? (
            <form onSubmit={handlePreview} className="mt-4 space-y-4">
              <div>
                <label
                  htmlFor="invite-code"
                  className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-text-subtle"
                >
                  Invite Code or URL
                </label>
                <input
                  id="invite-code"
                  type="text"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="Enter a code (abc12345) or paste a URL"
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
          ) : remotePreview ? (
            // Remote federation preview
            <div className="mt-4 space-y-4">
              <div className="rounded-md border border-border bg-bg-surface p-4">
                <div className="flex items-center gap-3">
                  <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-accent text-lg font-bold text-black">
                    {(
                      remotePreview.serverName?.[0] ??
                      new URL(remotePreview.instanceUrl).hostname[0]
                    ).toUpperCase()}
                  </div>
                  <div>
                    <div className="text-sm font-semibold text-text">
                      {remotePreview.serverName ??
                        `Remote server on ${new URL(remotePreview.instanceUrl).hostname}`}
                    </div>
                    {remotePreview.memberCount != null && (
                      <div className="text-xs text-text-muted">
                        {remotePreview.memberCount}{' '}
                        {remotePreview.memberCount === 1 ? 'member' : 'members'}
                      </div>
                    )}
                    <div className="mt-1 text-xs text-text-muted">
                      {new URL(remotePreview.instanceUrl).hostname}
                    </div>
                  </div>
                </div>
              </div>

              <div className="rounded-md border border-yellow-500/30 bg-yellow-500/10 p-3 text-xs text-text-muted">
                You are about to share your identity with{' '}
                <span className="font-semibold text-text">
                  {new URL(remotePreview.instanceUrl).hostname}
                </span>
                . This server is not operated by your home instance.
              </div>

              {error && <p className="text-xs text-error">{error}</p>}

              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setRemotePreview(null);
                    setError(null);
                  }}
                  disabled={joining}
                  className="rounded-md bg-bg-surface px-3 py-1.5 text-sm text-text-muted hover:bg-bg-elevated hover:text-text"
                >
                  Back
                </button>
                <button
                  type="button"
                  onClick={handleRemoteJoin}
                  disabled={joining}
                  className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-black hover:bg-accent-hover disabled:opacity-50"
                >
                  {joining ? 'Joining...' : 'Join Remote Server'}
                </button>
              </div>
            </div>
          ) : preview ? (
            // Local invite preview
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
                  disabled={joining}
                  className="rounded-md bg-bg-surface px-3 py-1.5 text-sm text-text-muted hover:bg-bg-elevated hover:text-text"
                >
                  Back
                </button>
                <button
                  type="button"
                  onClick={handleJoin}
                  disabled={joining}
                  className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-black hover:bg-accent-hover disabled:opacity-50"
                >
                  {joining ? 'Joining...' : 'Join Server'}
                </button>
              </div>
            </div>
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
