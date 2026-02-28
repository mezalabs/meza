import {
  ChannelType,
  joinServer,
  type PaneId,
  resolveInvite,
  type Server,
  useChannelStore,
  useServerStore,
} from '@meza/core';
import { BuildingsIcon, LinkIcon } from '@phosphor-icons/react';
import { useCallback, useState } from 'react';
import { useNavigationStore } from '../../stores/navigation.ts';
import { useTilingStore } from '../../stores/tiling.ts';

interface GetStartedViewProps {
  paneId: PaneId;
}

export function GetStartedView({ paneId }: GetStartedViewProps) {
  const [showJoin, setShowJoin] = useState(false);
  const [inviteCode, setInviteCode] = useState('');
  const [preview, setPreview] = useState<{
    server: Server;
    memberCount: number;
    code: string;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCreate = useCallback(() => {
    useTilingStore.getState().setPaneContent(paneId, { type: 'createServer' });
  }, [paneId]);

  const handleDismiss = useCallback(() => {
    sessionStorage.setItem('meza:getStartedDismissed', 'true');
    useTilingStore.getState().setPaneContent(paneId, { type: 'empty' });
  }, [paneId]);

  const handleResolveInvite = useCallback(async () => {
    if (!inviteCode.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const res = await resolveInvite(inviteCode.trim());
      if (res.server) {
        setPreview({
          server: res.server,
          memberCount: res.memberCount,
          code: res.invite?.code ?? inviteCode.trim(),
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid invite code');
    } finally {
      setLoading(false);
    }
  }, [inviteCode]);

  const handleJoin = useCallback(async () => {
    if (!preview) return;
    setLoading(true);
    setError(null);
    try {
      const server = await joinServer(preview.code);
      if (server) {
        useNavigationStore.getState().selectServer(server.id);
        // Check if server has onboarding
        const srv = useServerStore.getState().servers[server.id];
        if (srv?.onboardingEnabled) {
          useTilingStore.getState().setPaneContent(paneId, {
            type: 'serverOnboarding',
            serverId: server.id,
          });
        } else {
          // Navigate to first channel
          const channels = useChannelStore.getState().byServer[server.id] ?? [];
          const firstChannel =
            channels.find((c) => c.isDefault && c.type === ChannelType.TEXT) ??
            channels.find((c) => c.type === ChannelType.TEXT);
          if (firstChannel) {
            useTilingStore.getState().setPaneContent(paneId, {
              type: 'channel',
              channelId: firstChannel.id,
            });
          } else {
            useTilingStore.getState().setPaneContent(paneId, { type: 'empty' });
          }
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to join server');
    } finally {
      setLoading(false);
    }
  }, [preview, paneId]);

  return (
    <div className="flex flex-1 min-h-0 min-w-0 flex-col items-center justify-center p-8">
      <div className="w-full max-w-lg space-y-8">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-text">Welcome to Meza</h1>
          <p className="mt-2 text-sm text-text-muted">
            Get started by creating or joining a server.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-4">
          {/* Create card */}
          <button
            type="button"
            onClick={handleCreate}
            className="flex flex-col items-center gap-3 rounded-xl border border-border bg-bg-surface p-6 text-center transition-colors hover:border-accent hover:bg-bg-elevated"
          >
            <BuildingsIcon size={28} aria-hidden="true" />
            <span className="text-sm font-medium text-text">
              Create a Server
            </span>
            <span className="text-xs text-text-muted">
              Start your own space
            </span>
          </button>

          {/* Join card */}
          <button
            type="button"
            onClick={() => setShowJoin(true)}
            className="flex flex-col items-center gap-3 rounded-xl border border-border bg-bg-surface p-6 text-center transition-colors hover:border-accent hover:bg-bg-elevated"
          >
            <LinkIcon size={28} aria-hidden="true" />
            <span className="text-sm font-medium text-text">Join a Server</span>
            <span className="text-xs text-text-muted">Have an invite?</span>
          </button>
        </div>

        {/* Inline join flow */}
        {showJoin && (
          <div className="space-y-3 rounded-xl border border-border bg-bg-surface p-4">
            {!preview ? (
              <>
                <label
                  htmlFor="invite-code"
                  className="block text-sm font-medium text-text"
                >
                  Enter an invite code or link
                </label>
                <div className="flex gap-2">
                  <input
                    id="invite-code"
                    type="text"
                    value={inviteCode}
                    onChange={(e) => setInviteCode(e.target.value)}
                    onKeyDown={(e) =>
                      e.key === 'Enter' && handleResolveInvite()
                    }
                    placeholder="abc123 or https://meza.chat/invite/abc123"
                    className="flex-1 rounded-lg border border-border bg-bg-base px-3 py-2 text-sm text-text placeholder:text-text-muted focus:border-accent focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={handleResolveInvite}
                    disabled={loading || !inviteCode.trim()}
                    className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-black hover:bg-accent-hover disabled:opacity-50"
                  >
                    {loading ? '...' : 'Go'}
                  </button>
                </div>
              </>
            ) : (
              <div className="space-y-3">
                <div className="flex items-center gap-3">
                  {preview.server.iconUrl ? (
                    <img
                      src={preview.server.iconUrl}
                      alt=""
                      className="h-10 w-10 rounded-full object-cover"
                    />
                  ) : (
                    <div className="flex h-10 w-10 items-center justify-center rounded-full bg-bg-elevated text-sm font-medium text-text-muted">
                      {preview.server.name.charAt(0).toUpperCase()}
                    </div>
                  )}
                  <div>
                    <p className="text-sm font-medium text-text">
                      {preview.server.name}
                    </p>
                    <p className="text-xs text-text-muted">
                      {preview.memberCount} member
                      {preview.memberCount !== 1 ? 's' : ''}
                    </p>
                  </div>
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setPreview(null);
                      setInviteCode('');
                    }}
                    className="flex-1 rounded-lg border border-border px-4 py-2 text-sm text-text-muted hover:text-text"
                  >
                    Back
                  </button>
                  <button
                    type="button"
                    onClick={handleJoin}
                    disabled={loading}
                    className="flex-1 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-black hover:bg-accent-hover disabled:opacity-50"
                  >
                    {loading ? 'Joining...' : 'Join'}
                  </button>
                </div>
              </div>
            )}

            {error && <p className="text-xs text-error">{error}</p>}
          </div>
        )}

        <div className="text-center">
          <button
            type="button"
            onClick={handleDismiss}
            className="text-xs text-text-muted hover:text-text"
          >
            Maybe later
          </button>
        </div>
      </div>
    </div>
  );
}
