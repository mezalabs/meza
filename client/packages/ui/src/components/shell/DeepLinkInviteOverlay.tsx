import { joinServer, resolveInvite, useInviteStore } from '@meza/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigationStore } from '../../stores/navigation.ts';
import { useTilingStore } from '../../stores/tiling.ts';

interface ServerPreview {
  name: string;
  memberCount: number;
}

/**
 * Full-screen overlay shown to authenticated users when a `meza://` deep link
 * sets a pending invite. Displays the server preview with accept/decline actions.
 * Declining clears the invite and returns to the normal app view.
 */
export function DeepLinkInviteOverlay() {
  const pendingCode = useInviteStore((s) => s.pendingCode);
  const pendingHost = useInviteStore((s) => s.pendingHost);
  // Subscribed for its side effect: any setPendingCode call (even with the
  // same value as before) bumps this counter, so the reset effect below can
  // detect a re-click of the same invite that Zustand's Object.is equality
  // would otherwise hide.
  const pendingNonce = useInviteStore((s) => s.pendingNonce);

  const [preview, setPreview] = useState<ServerPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [joining, setJoining] = useState(false);
  const [dismissing, setDismissing] = useState(false);
  // Tracks which invite code the current dismiss animation applies to so a
  // freshly-arrived deep link isn't stomped by the previous animation's clear.
  const dismissingCodeRef = useRef<string | null>(null);
  // Holds the active fallback timer so we can cancel it on unmount or when
  // the dismiss completes via animationend (whichever fires first).
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Only render when there's a deep-link invite (pendingHost distinguishes
  // deep links from web URL invites which only set pendingCode).
  const visible = !!pendingCode && !!pendingHost;

  // Reset the dismiss animation whenever setPendingCode is called with a
  // non-null value, including when the same code is re-clicked after "Not
  // now". We key on pendingNonce (not pendingCode) so React fires this
  // effect even when the value of pendingCode is unchanged — Zustand's
  // Object.is equality would otherwise hide a same-value re-set.
  // biome-ignore lint/correctness/useExhaustiveDependencies: pendingNonce is the trigger; pendingCode is read inside but its identity doesn't matter for re-running
  useEffect(() => {
    if (pendingCode) {
      setDismissing(false);
      dismissingCodeRef.current = null;
      if (dismissTimerRef.current) {
        clearTimeout(dismissTimerRef.current);
        dismissTimerRef.current = null;
      }
    }
  }, [pendingNonce]);

  // Cancel any in-flight dismiss timer on unmount so we don't run zustand
  // mutations after the component is gone.
  useEffect(
    () => () => {
      if (dismissTimerRef.current) {
        clearTimeout(dismissTimerRef.current);
        dismissTimerRef.current = null;
      }
    },
    [],
  );

  useEffect(() => {
    if (!pendingCode || !pendingHost) return;

    let cancelled = false;
    setLoading(true);
    setError(null);
    setPreview(null);

    resolveInvite(pendingCode)
      .then((res) => {
        if (!cancelled && res.server) {
          setPreview({ name: res.server.name, memberCount: res.memberCount });
        }
      })
      .catch(() => {
        if (!cancelled) setError('This invite is no longer valid.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [pendingCode, pendingHost]);

  const handleAccept = useCallback(async () => {
    if (!pendingCode) return;
    setJoining(true);
    setError(null);
    try {
      const server = await joinServer(pendingCode);
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
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to join server';
      if (message.toLowerCase().includes('already')) {
        useInviteStore.getState().clearPendingCode();
      } else {
        setError(message);
      }
    } finally {
      setJoining(false);
    }
  }, [pendingCode]);

  const handleDecline = useCallback(() => {
    const codeToDismiss = pendingCode;
    dismissingCodeRef.current = codeToDismiss;
    setDismissing(true);
    // Fallback: if animation doesn't fire (e.g. prefers-reduced-motion),
    // clear the store after the animation duration. Only clear if the
    // store still holds the same invite — otherwise a new link arrived.
    if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);
    dismissTimerRef.current = setTimeout(() => {
      dismissTimerRef.current = null;
      const current = useInviteStore.getState().pendingCode;
      if (current === codeToDismiss) {
        useInviteStore.getState().clearPendingCode();
      }
      dismissingCodeRef.current = null;
    }, 200);
  }, [pendingCode]);

  // After the exit animation completes, clear the store — but only if the
  // invite being dismissed is still the one in the store. Filter on
  // currentTarget so a future finite animation on a child element can't
  // bubble up and trip this handler mid-fade.
  const handleAnimationEnd = useCallback(
    (e: React.AnimationEvent<HTMLDivElement>) => {
      if (e.target !== e.currentTarget) return;
      if (!dismissing) return;
      const current = useInviteStore.getState().pendingCode;
      if (current === dismissingCodeRef.current) {
        useInviteStore.getState().clearPendingCode();
      }
      dismissingCodeRef.current = null;
      if (dismissTimerRef.current) {
        clearTimeout(dismissTimerRef.current);
        dismissTimerRef.current = null;
      }
    },
    [dismissing],
  );

  if (!visible) return null;

  return (
    <div
      className={`fixed inset-0 z-50 flex flex-col items-center justify-center safe-top safe-bottom ${
        dismissing ? 'animate-fade-out' : 'animate-fade-in'
      }`}
      style={{
        backgroundColor: 'rgba(15, 15, 15, 0.92)',
        backdropFilter: 'blur(20px)',
      }}
      onAnimationEnd={handleAnimationEnd}
    >
      {/* Decorative glow behind the avatar */}
      <div
        className="pointer-events-none absolute top-1/3 h-64 w-64 -translate-y-1/2 rounded-full opacity-20 blur-3xl"
        style={{ backgroundColor: 'var(--color-accent)' }}
      />

      <div className="relative flex w-full max-w-sm flex-col items-center gap-8 px-6">
        {/* Loading state */}
        {loading && (
          <div className="flex flex-col items-center gap-4">
            <div className="h-20 w-20 animate-pulse rounded-2xl bg-bg-elevated" />
            <div className="h-5 w-40 animate-pulse rounded bg-bg-elevated" />
            <div className="h-4 w-24 animate-pulse rounded bg-bg-elevated" />
          </div>
        )}

        {/* Error state */}
        {!loading && error && !preview && (
          <div className="flex flex-col items-center gap-4 text-center">
            <div className="flex h-20 w-20 items-center justify-center rounded-2xl bg-bg-elevated">
              <span className="text-3xl text-text-subtle">?</span>
            </div>
            <p className="text-base font-medium text-error">{error}</p>
            <p className="text-sm text-text-muted">
              The invite may have expired or been revoked.
            </p>
          </div>
        )}

        {/* Server preview */}
        {!loading && preview && (
          <>
            {/* Server avatar */}
            <div className="flex h-20 w-20 items-center justify-center rounded-2xl bg-accent shadow-lg shadow-accent/20">
              <span className="text-3xl font-bold text-black">
                {preview.name.charAt(0).toUpperCase()}
              </span>
            </div>

            {/* Invitation label */}
            <div className="flex flex-col items-center gap-1 text-center">
              <p className="text-sm font-medium uppercase tracking-widest text-text-muted">
                You've been invited to
              </p>
              <h1 className="text-2xl font-semibold text-text">
                {preview.name}
              </h1>
              <p className="text-sm text-text-muted">
                {preview.memberCount}{' '}
                {preview.memberCount === 1 ? 'member' : 'members'}
              </p>
            </div>

            {/* Error during join */}
            {error && (
              <p className="rounded-lg bg-error/10 px-4 py-2 text-center text-sm text-error">
                {error}
              </p>
            )}
          </>
        )}

        {/* Actions */}
        <div className="flex w-full flex-col gap-3">
          {(preview || (error && !loading)) && (
            <>
              {preview && (
                <button
                  type="button"
                  onClick={handleAccept}
                  disabled={joining}
                  className="w-full rounded-xl bg-accent py-4 text-base font-semibold text-black transition-colors hover:bg-accent-hover disabled:opacity-50"
                >
                  {joining ? 'Joining...' : 'Accept Invite'}
                </button>
              )}
              <button
                type="button"
                onClick={handleDecline}
                disabled={joining}
                className={`w-full rounded-xl py-3 text-sm transition-colors disabled:opacity-50 ${
                  preview
                    ? 'text-text-muted hover:text-text'
                    : 'bg-bg-elevated text-text hover:bg-bg-hover'
                }`}
              >
                {preview ? 'Not now' : 'Go back'}
              </button>
            </>
          )}
        </div>

        {/* Deep link origin hint */}
        {pendingHost && (
          <p className="text-center text-xs text-text-subtle">
            from {pendingHost}
          </p>
        )}
      </div>
    </div>
  );
}
