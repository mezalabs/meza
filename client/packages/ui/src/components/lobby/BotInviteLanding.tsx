import {
  acceptBotInvite,
  getEffectivePermissions,
  hasPermission,
  PERMISSION_INFO,
  Permissions,
  type PermissionKey,
  resolveBotInvite,
  useAuthStore,
  useBotInviteStore,
  useServerStore,
} from '@meza/core';
import { IconContext } from '@phosphor-icons/react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Avatar } from '../shared/Avatar.tsx';
import { AuthForm } from './AuthForm.tsx';

interface BotPreview {
  name: string;
  displayName: string;
  description: string;
  avatarUrl: string;
  ownerUsername: string;
  requestedPermissions: bigint;
}

interface ServerOption {
  id: string;
  name: string;
  iconUrl: string;
}

/** Map a bigint bitmask to human-readable permission names. */
function getRequestedPermissionNames(perms: bigint): string[] {
  const names: string[] = [];
  for (const [key, bit] of Object.entries(Permissions)) {
    if ((perms & bit) !== 0n) {
      const info = PERMISSION_INFO[key as PermissionKey];
      if (info) names.push(info.name);
    }
  }
  return names;
}

export function BotInviteLanding() {
  const pendingCode = useBotInviteStore((s) => s.pendingCode);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const servers = useServerStore((s) => s.servers);

  const [preview, setPreview] = useState<BotPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Server selector state
  const [eligibleServers, setEligibleServers] = useState<ServerOption[]>([]);
  const [selectedServerId, setSelectedServerId] = useState<string>('');
  const [loadingServers, setLoadingServers] = useState(false);

  // Accept state
  const [accepting, setAccepting] = useState(false);
  const [acceptError, setAcceptError] = useState<string | null>(null);
  const [successServer, setSuccessServer] = useState<string | null>(null);

  // Resolve bot invite preview (public, no auth required).
  useEffect(() => {
    if (!pendingCode) return;

    let cancelled = false;
    setLoading(true);
    setError(null);

    resolveBotInvite(pendingCode)
      .then((res) => {
        if (cancelled) return;
        if (res.bot) {
          setPreview({
            name: res.bot.username,
            displayName: res.bot.displayName,
            description: res.bot.description,
            avatarUrl: res.bot.avatarUrl,
            ownerUsername: res.ownerUsername,
            requestedPermissions: res.invite?.requestedPermissions ?? 0n,
          });
        } else {
          setError('This bot invite is no longer valid.');
          useBotInviteStore.getState().clearPendingCode();
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'This bot invite is no longer valid.');
          useBotInviteStore.getState().clearPendingCode();
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [pendingCode]);

  // When authenticated, find servers where user has ManageBots permission.
  useEffect(() => {
    if (!isAuthenticated || !preview) return;

    const serverList = Object.values(servers);
    if (serverList.length === 0) return;

    let cancelled = false;
    setLoadingServers(true);

    const checkPermissions = async () => {
      const eligible: ServerOption[] = [];

      for (const server of serverList) {
        try {
          const perms = await getEffectivePermissions(server.id);
          if (hasPermission(perms, Permissions.MANAGE_BOTS)) {
            eligible.push({
              id: server.id,
              name: server.name,
              iconUrl: server.iconUrl,
            });
          }
        } catch {
          // Skip servers where we can't check permissions.
        }
      }

      if (!cancelled) {
        setEligibleServers(eligible);
        if (eligible.length === 1) {
          setSelectedServerId(eligible[0].id);
        }
        setLoadingServers(false);
      }
    };

    checkPermissions();

    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, preview, servers]);

  const permissionNames = useMemo(() => {
    if (!preview) return [];
    return getRequestedPermissionNames(preview.requestedPermissions);
  }, [preview]);

  const handleAccept = useCallback(async () => {
    if (!pendingCode || !selectedServerId) return;

    setAccepting(true);
    setAcceptError(null);

    try {
      await acceptBotInvite(pendingCode, selectedServerId);
      const server = eligibleServers.find((s) => s.id === selectedServerId);
      setSuccessServer(server?.name ?? 'the server');
      useBotInviteStore.getState().clearPendingCode();
    } catch (err) {
      setAcceptError(err instanceof Error ? err.message : 'Failed to add bot.');
    } finally {
      setAccepting(false);
    }
  }, [pendingCode, selectedServerId, eligibleServers]);

  const handleDismiss = useCallback(() => {
    useBotInviteStore.getState().clearPendingCode();
  }, []);

  // Success state
  if (successServer) {
    return (
      <IconContext.Provider value={{ weight: 'fill' }}>
        <div className="flex min-h-0 w-full flex-1 items-center justify-center bg-bg-base">
          <div className="w-full max-w-sm space-y-6 px-4 text-center">
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-green-500/20 text-3xl">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="currentColor"
                className="h-8 w-8 text-green-500"
              >
                <path
                  fillRule="evenodd"
                  d="M2.25 12c0-5.385 4.365-9.75 9.75-9.75s9.75 4.365 9.75 9.75-4.365 9.75-9.75 9.75S2.25 17.385 2.25 12zm13.36-1.814a.75.75 0 10-1.22-.872l-3.236 4.53L9.53 12.22a.75.75 0 00-1.06 1.06l2.25 2.25a.75.75 0 001.14-.094l3.75-5.25z"
                  clipRule="evenodd"
                />
              </svg>
            </div>
            <h1 className="text-xl font-semibold text-text">
              Bot added successfully!
            </h1>
            <p className="text-sm text-text-muted">
              The bot has been added to{' '}
              <span className="font-medium text-accent">{successServer}</span>.
            </p>
            <button
              onClick={handleDismiss}
              className="mt-4 rounded-lg bg-accent px-6 py-2 text-sm font-medium text-black transition-colors hover:bg-accent/90"
            >
              Continue to Meza
            </button>
          </div>
        </div>
      </IconContext.Provider>
    );
  }

  return (
    <IconContext.Provider value={{ weight: 'fill' }}>
      <div className="flex min-h-0 w-full flex-1 items-center justify-center bg-bg-base">
        <div className="w-full max-w-sm space-y-6 px-4">
          {/* Bot preview */}
          <div className="text-center">
            {loading ? (
              <div className="flex flex-col items-center gap-3">
                <div className="h-6 w-6 animate-spin rounded-full border-2 border-current border-t-transparent text-text-muted" />
                <span className="text-sm text-text-muted">
                  Loading bot invite...
                </span>
              </div>
            ) : error ? (
              <>
                <div className="text-sm text-error">{error}</div>
                <button
                  onClick={handleDismiss}
                  className="mt-4 text-sm text-text-muted underline hover:text-text"
                >
                  Go back
                </button>
              </>
            ) : preview ? (
              <>
                <div className="mx-auto">
                  <Avatar
                    avatarUrl={preview.avatarUrl || undefined}
                    displayName={preview.displayName || preview.name}
                    size="xl"
                    className="mx-auto"
                  />
                </div>
                <h1 className="mt-4 text-xl font-semibold text-text">
                  {preview.displayName || preview.name}
                </h1>
                <p className="mt-1 text-sm text-text-muted">
                  @{preview.name}
                </p>
                {preview.description && (
                  <p className="mt-2 text-sm text-text-muted">
                    {preview.description}
                  </p>
                )}
                <p className="mt-2 text-xs text-text-muted">
                  by {preview.ownerUsername}
                </p>

                {/* Requested permissions */}
                {permissionNames.length > 0 && (
                  <div className="mt-4 rounded-lg border border-border bg-bg-surface p-3 text-left">
                    <p className="mb-2 text-xs font-medium uppercase tracking-wider text-text-muted">
                      Requested Permissions
                    </p>
                    <ul className="space-y-1">
                      {permissionNames.map((name) => (
                        <li
                          key={name}
                          className="flex items-center gap-2 text-sm text-text"
                        >
                          <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-accent" />
                          {name}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            ) : null}
          </div>

          {/* Action area */}
          {preview && !loading && (
            <>
              <div className="border-t border-border" />

              {isAuthenticated ? (
                <div className="space-y-4">
                  {/* Server selector */}
                  {loadingServers ? (
                    <div className="flex items-center justify-center gap-2">
                      <div className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent text-text-muted" />
                      <span className="text-sm text-text-muted">
                        Loading your servers...
                      </span>
                    </div>
                  ) : eligibleServers.length === 0 ? (
                    <div className="text-center">
                      <p className="text-sm text-text-muted">
                        You don't have the{' '}
                        <span className="font-medium">Manage Bots</span>{' '}
                        permission in any of your servers.
                      </p>
                      <button
                        onClick={handleDismiss}
                        className="mt-3 text-sm text-text-muted underline hover:text-text"
                      >
                        Go back
                      </button>
                    </div>
                  ) : (
                    <>
                      <div>
                        <label
                          htmlFor="server-select"
                          className="mb-1.5 block text-sm font-medium text-text"
                        >
                          Add to server
                        </label>
                        <select
                          id="server-select"
                          value={selectedServerId}
                          onChange={(e) => setSelectedServerId(e.target.value)}
                          className="w-full rounded-lg border border-border bg-bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent"
                        >
                          <option value="">Select a server...</option>
                          {eligibleServers.map((server) => (
                            <option key={server.id} value={server.id}>
                              {server.name}
                            </option>
                          ))}
                        </select>
                      </div>

                      {acceptError && (
                        <p className="text-sm text-error">{acceptError}</p>
                      )}

                      <button
                        onClick={handleAccept}
                        disabled={!selectedServerId || accepting}
                        className="w-full rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-black transition-colors hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {accepting ? (
                          <span className="flex items-center justify-center gap-2">
                            <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                            Adding bot...
                          </span>
                        ) : (
                          'Add to Server'
                        )}
                      </button>
                    </>
                  )}
                </div>
              ) : (
                <div>
                  <p className="mb-3 text-center text-sm text-text-muted">
                    Log in to add this bot to your server.
                  </p>
                  <AuthForm />
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </IconContext.Provider>
  );
}
