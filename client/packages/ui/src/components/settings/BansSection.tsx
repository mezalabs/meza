import { listBans, unbanMember, useAuthStore } from '@meza/core';
import { useEffect, useState } from 'react';
import { resolveDisplayName } from '../../hooks/useDisplayName.ts';

type Ban = Awaited<ReturnType<typeof listBans>>[number];

interface BansSectionProps {
  serverId: string;
}

export function BansSection({ serverId }: BansSectionProps) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const [bans, setBans] = useState<Ban[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [unbanConfirmId, setUnbanConfirmId] = useState<string | null>(null);
  const [isUnbanning, setIsUnbanning] = useState(false);

  useEffect(() => {
    if (!isAuthenticated || !serverId) return;
    setIsLoading(true);
    setError('');
    listBans(serverId)
      .then((result) => {
        setBans(result);
      })
      .catch(() => {
        setError('Failed to load bans');
      })
      .finally(() => {
        setIsLoading(false);
      });
  }, [serverId, isAuthenticated]);

  async function handleUnban(userId: string) {
    setIsUnbanning(true);
    try {
      await unbanMember(serverId, userId);
      setBans((prev) => prev.filter((b) => b.userId !== userId));
      setUnbanConfirmId(null);
    } catch {
      setError('Failed to unban member');
    } finally {
      setIsUnbanning(false);
    }
  }

  return (
    <div>
      <h2 className="mb-4 text-lg font-semibold text-text">Bans</h2>

      {isLoading && <p className="text-sm text-text-muted">Loading bans...</p>}

      {error && <p className="mb-3 text-xs text-error">{error}</p>}

      {!isLoading && bans.length === 0 && (
        <p className="text-sm text-text-muted">No bans.</p>
      )}

      <div className="flex flex-col gap-2">
        {bans.map((ban) => {
          const date = ban.createdAt
            ? new Date(Number(ban.createdAt.seconds) * 1000)
            : null;

          return (
            <div
              key={ban.userId}
              className="flex items-center justify-between rounded-lg border border-border bg-bg-surface p-3"
            >
              <div className="flex flex-col gap-0.5">
                <span className="text-sm font-medium text-text">
                  {resolveDisplayName(ban.userId)}
                </span>
                {ban.reason && (
                  <span className="text-xs text-text-muted">
                    Reason: {ban.reason}
                  </span>
                )}
                {date && (
                  <span className="text-xs text-text-subtle">
                    Banned {date.toLocaleDateString()}
                  </span>
                )}
              </div>
              <div>
                {unbanConfirmId === ban.userId ? (
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      disabled={isUnbanning}
                      onClick={() => handleUnban(ban.userId)}
                      className="rounded-md bg-error px-2 py-1 text-sm font-medium text-white hover:bg-error/80 disabled:opacity-50"
                    >
                      {isUnbanning ? 'Unbanning...' : 'Confirm'}
                    </button>
                    <button
                      type="button"
                      disabled={isUnbanning}
                      onClick={() => setUnbanConfirmId(null)}
                      className="rounded-md px-2 py-1 text-sm text-text-muted hover:text-text"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setUnbanConfirmId(ban.userId)}
                    className="rounded-md bg-bg-elevated px-3 py-1 text-sm text-text-muted hover:bg-bg-surface hover:text-text"
                  >
                    Unban
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
