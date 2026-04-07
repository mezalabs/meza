import { resolveIconUrl, type Server } from '@meza/core';
import { useCallback, useState } from 'react';

interface InviteStepProps {
  server: Server;
  /**
   * Pre-built invite URL (already includes the E2EE key-bundle secret as a
   * URL fragment when one was generated). Null when invite creation failed.
   */
  inviteUrl: string | null;
}

export function InviteStep({ server, inviteUrl }: InviteStepProps) {
  const [copied, setCopied] = useState(false);

  const shareMessage = inviteUrl
    ? `Join ${server.name} on Meza! ${inviteUrl}`
    : '';

  const handleCopy = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback for older browsers
    }
  }, []);

  return (
    <div className="space-y-6">
      <div className="text-center">
        {server.iconUrl ? (
          <img
            src={resolveIconUrl(server.iconUrl)}
            alt=""
            className="mx-auto mb-3 h-16 w-16 rounded-full object-cover"
          />
        ) : (
          <div className="mx-auto mb-3 flex h-16 w-16 items-center justify-center rounded-full bg-bg-elevated text-xl font-bold text-text-muted">
            {server.name.charAt(0).toUpperCase()}
          </div>
        )}
        <h2 className="text-lg font-semibold text-text">
          Your server is ready!
        </h2>
        <p className="mt-1 text-sm text-text-muted">
          Invite people to <span className="text-text">{server.name}</span>
        </p>
      </div>

      {inviteUrl && (
        <div className="space-y-4">
          {/* Invite link */}
          <div>
            <label
              htmlFor="invite-link"
              className="mb-1 block text-xs font-medium text-text-muted"
            >
              Invite link
            </label>
            <div className="flex gap-2">
              <input
                id="invite-link"
                type="text"
                value={inviteUrl}
                readOnly
                className="flex-1 border border-border bg-bg-base text-text focus:outline-none"
              />
              <button
                type="button"
                onClick={() => handleCopy(inviteUrl)}
                className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-black hover:bg-accent-hover"
              >
                {copied ? 'Copied!' : 'Copy'}
              </button>
            </div>
          </div>

          {/* Share message */}
          <div>
            <label
              htmlFor="share-message"
              className="mb-1 block text-xs font-medium text-text-muted"
            >
              Share message
            </label>
            <div className="flex gap-2">
              <input
                id="share-message"
                type="text"
                value={shareMessage}
                readOnly
                className="flex-1 border border-border bg-bg-base text-text focus:outline-none"
              />
              <button
                type="button"
                onClick={() => handleCopy(shareMessage)}
                className="rounded-lg border border-border px-3 py-2 text-sm text-text-muted hover:text-text"
              >
                Copy
              </button>
            </div>
          </div>

          <p className="text-center text-xs text-text-muted">
            This invite expires in 7 days.
          </p>
        </div>
      )}
    </div>
  );
}
