import { buildDeepLinkUrl, resolveInvite, useInviteStore } from '@meza/core';
import { IconContext } from '@phosphor-icons/react';
import { useCallback, useEffect, useState } from 'react';
import { AuthForm } from './AuthForm.tsx';

interface ServerPreview {
  name: string;
  memberCount: number;
}

export function InviteLanding() {
  const pendingCode = useInviteStore((s) => s.pendingCode);
  const inviteSecret = useInviteStore((s) => s.inviteSecret);

  const [preview, setPreview] = useState<ServerPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Resolve invite preview (no auth required).
  useEffect(() => {
    if (!pendingCode) return;

    let cancelled = false;
    setLoading(true);
    resolveInvite(pendingCode)
      .then((res) => {
        if (!cancelled && res.server) {
          setPreview({ name: res.server.name, memberCount: res.memberCount });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setPreview(null);
          setError('This invite is no longer valid.');
          useInviteStore.getState().clearPendingCode();
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [pendingCode]);

  const handleOpenInApp = useCallback(() => {
    if (!pendingCode) return;
    const url = buildDeepLinkUrl({
      host: window.location.hostname,
      code: pendingCode,
      secret: inviteSecret ?? undefined,
    });
    // Use a hidden <a> element instead of window.location.href to avoid
    // ERR_UNKNOWN_URL_SCHEME errors on some Android browsers. The anchor
    // must be attached to the document for the click to trigger the OS
    // protocol handler reliably across browsers (Chrome/Safari otherwise
    // drop orphan-anchor clicks to custom schemes on repeat attempts).
    // Removal is deferred to the next tick so older Android WebViews —
    // which post protocol-handler dispatch to the message loop — see the
    // node still attached when they read the click event back.
    const a = document.createElement('a');
    a.href = url;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      a.remove();
    }, 0);
  }, [pendingCode, inviteSecret]);

  return (
    <IconContext.Provider value={{ weight: 'fill' }}>
      <div className="flex min-h-0 w-full flex-1 items-center justify-center bg-bg-base">
        <div className="w-full max-w-sm space-y-6 px-4">
          {/* Server preview */}
          <div className="text-center">
            {loading ? (
              <div className="text-sm text-text-muted">Loading invite...</div>
            ) : error ? (
              <>
                <div className="text-sm text-error">{error}</div>
                <p className="mt-2 text-sm text-text-muted">
                  You can still create an account below.
                </p>
              </>
            ) : preview ? (
              <>
                <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-accent text-2xl font-bold text-black">
                  {preview.name.charAt(0).toUpperCase()}
                </div>
                <h1 className="mt-4 text-xl font-semibold text-text">
                  You've been invited to join
                </h1>
                <p className="mt-1 text-lg font-medium text-accent">
                  {preview.name}
                </p>
                <p className="mt-1 text-sm text-text-muted">
                  {preview.memberCount}{' '}
                  {preview.memberCount === 1 ? 'member' : 'members'}
                </p>
              </>
            ) : null}
          </div>

          {/* Open in App CTA */}
          {preview && pendingCode && (
            <button
              type="button"
              onClick={handleOpenInApp}
              className="w-full rounded-lg bg-accent px-4 py-3 text-sm font-semibold text-black hover:bg-accent-hover"
            >
              Open in Meza
            </button>
          )}

          {/* Divider */}
          <div className="flex items-center gap-3">
            <div className="flex-1 border-t border-border" />
            {preview && (
              <span className="text-xs text-text-muted">
                Or continue in browser
              </span>
            )}
            <div className="flex-1 border-t border-border" />
          </div>

          {/* Auth form */}
          <div>
            <p className="mb-3 text-center text-sm text-text-muted">
              {preview
                ? 'Create an account to accept this invite.'
                : 'Create an account to get started.'}
            </p>
            <AuthForm />
          </div>
        </div>
      </div>
    </IconContext.Provider>
  );
}
