import { type Device, listDevices, revokeDevice } from '@meza/core';
import { useEffect, useState } from 'react';

export function DevicesSection() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(true);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listDevices()
      .then(setDevices)
      .catch((err) =>
        setError(err instanceof Error ? err.message : 'Failed to load devices'),
      )
      .finally(() => setLoading(false));
  }, []);

  async function handleRevoke(deviceId: string) {
    setRevoking(deviceId);
    setError(null);
    try {
      await revokeDevice(deviceId);
      setDevices((prev) => prev.filter((d) => d.id !== deviceId));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to revoke device');
    } finally {
      setRevoking(null);
    }
  }

  if (loading) {
    return <div className="text-sm text-text-muted">Loading devices...</div>;
  }

  return (
    <div className="max-w-md space-y-6">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-text-subtle">
        Devices
      </h2>

      <p className="text-xs text-text-muted">
        Manage devices that are signed into your account. Revoking a device will
        sign it out and remove its encryption keys.
      </p>

      {error && <p className="text-xs text-red-400">{error}</p>}

      {devices.length === 0 ? (
        <p className="text-xs text-text-subtle">No devices registered.</p>
      ) : (
        <div className="space-y-2">
          {devices.map((device) => (
            <div
              key={device.id}
              className="flex items-center justify-between rounded-md border border-border px-3 py-2.5"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-text truncate">
                    {device.name || 'Unknown device'}
                  </span>
                  {device.isCurrent && (
                    <span className="shrink-0 rounded bg-accent/20 px-1.5 py-0.5 text-[10px] font-semibold text-accent">
                      Current
                    </span>
                  )}
                </div>
                <div className="text-xs text-text-subtle">
                  {device.platform || 'Unknown platform'}
                  {device.lastSeenAt && (
                    <>
                      {' '}
                      &middot; Last seen {formatTimestamp(device.lastSeenAt)}
                    </>
                  )}
                </div>
              </div>
              {!device.isCurrent && (
                <button
                  type="button"
                  onClick={() => handleRevoke(device.id)}
                  disabled={revoking === device.id}
                  className="shrink-0 rounded px-2 py-1 text-xs font-medium text-red-400 hover:bg-red-400/10 transition-colors disabled:opacity-50"
                >
                  {revoking === device.id ? 'Revoking...' : 'Revoke'}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function formatTimestamp(ts: { seconds: bigint } | undefined): string {
  if (!ts) return 'Unknown';
  const date = new Date(Number(ts.seconds) * 1000);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}
