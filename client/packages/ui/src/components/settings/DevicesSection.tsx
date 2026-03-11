import {
  type Device,
  listDevices,
  revokeAllOtherDevices,
  revokeDevice,
} from '@meza/core';
import {
  Browser as BrowserIcon,
  Desktop as DesktopIcon,
  DeviceMobile as MobileIcon,
  SignOut as SignOutIcon,
} from '@phosphor-icons/react';
import { useEffect, useState } from 'react';

export function DevicesSection() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(true);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [revokingAll, setRevokingAll] = useState(false);
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

  async function handleRevokeAllOther() {
    setRevokingAll(true);
    setError(null);
    try {
      await revokeAllOtherDevices();
      setDevices((prev) => prev.filter((d) => d.isCurrent));
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to sign out devices',
      );
      // Refresh the list to show actual state
      listDevices()
        .then(setDevices)
        .catch(() => {});
    } finally {
      setRevokingAll(false);
    }
  }

  if (loading) {
    return <div className="text-sm text-text-muted">Loading devices...</div>;
  }

  const currentDevice = devices.find((d) => d.isCurrent);
  const otherDevices = devices.filter((d) => !d.isCurrent);

  return (
    <div className="max-w-md space-y-6">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-text-subtle">
        Devices
      </h2>

      <p className="text-xs text-text-muted">
        Manage devices signed into your account. Revoking a device signs it out
        and removes its encryption keys.
      </p>

      {error && <p className="text-xs text-red-400">{error}</p>}

      {devices.length === 0 ? (
        <p className="text-xs text-text-subtle">No devices registered.</p>
      ) : (
        <div className="space-y-4">
          {/* Current device — always shown first */}
          {currentDevice && (
            <div className="rounded-lg border border-accent/30 bg-accent/5 px-3.5 py-3">
              <div className="flex items-center gap-3">
                <DeviceIcon device={currentDevice} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-text truncate">
                      {deviceDisplayName(currentDevice)}
                    </span>
                    <span className="shrink-0 rounded-full bg-accent/20 px-2 py-0.5 text-[10px] font-semibold text-accent">
                      This device
                    </span>
                  </div>
                  <div className="text-xs text-text-subtle mt-0.5">
                    Active now
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Other devices */}
          {otherDevices.length > 0 && (
            <>
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-text-subtle">
                  Other sessions ({otherDevices.length})
                </span>
                {otherDevices.length > 1 && (
                  <button
                    type="button"
                    onClick={handleRevokeAllOther}
                    disabled={revokingAll}
                    className="flex items-center gap-1 rounded px-2 py-1 text-xs font-medium text-red-400 hover:bg-red-400/10 transition-colors disabled:opacity-50"
                  >
                    <SignOutIcon size={12} weight="bold" />
                    {revokingAll ? 'Signing out...' : 'Sign out all'}
                  </button>
                )}
              </div>
              <div className="space-y-1.5">
                {otherDevices.map((device) => (
                  <div
                    key={device.id}
                    className="group flex items-center gap-3 rounded-lg border border-border px-3.5 py-2.5 hover:border-border-hover transition-colors"
                  >
                    <DeviceIcon device={device} />
                    <div className="min-w-0 flex-1">
                      <span className="text-sm font-medium text-text truncate block">
                        {deviceDisplayName(device)}
                      </span>
                      <span className="text-xs text-text-subtle">
                        {formatTimestamp(device.lastSeenAt)}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleRevoke(device.id)}
                      disabled={revoking === device.id || revokingAll}
                      className="shrink-0 rounded px-2 py-1 text-xs font-medium text-red-400 opacity-0 group-hover:opacity-100 focus:opacity-100 hover:bg-red-400/10 transition-all disabled:opacity-50"
                    >
                      {revoking === device.id ? 'Revoking...' : 'Sign out'}
                    </button>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function DeviceIcon({ device }: { device: Device }) {
  const className = 'shrink-0 text-text-subtle';
  switch (device.platform) {
    case 'android':
    case 'ios':
      return <MobileIcon size={20} weight="regular" className={className} />;
    case 'electron':
      return <DesktopIcon size={20} weight="regular" className={className} />;
    default:
      return <BrowserIcon size={20} weight="regular" className={className} />;
  }
}

/** Build a readable display name, falling back to platform if no name is set. */
function deviceDisplayName(device: Device): string {
  if (device.name) return device.name;
  switch (device.platform) {
    case 'android':
      return 'Android';
    case 'ios':
      return 'iOS';
    case 'electron':
      return 'Desktop';
    default:
      return 'Web';
  }
}

function formatTimestamp(ts: { seconds: bigint } | undefined): string {
  if (!ts) return 'Unknown';
  const date = new Date(Number(ts.seconds) * 1000);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return 'Active now';
  if (diffMins < 60) return `Last seen ${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `Last seen ${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `Last seen ${diffDays}d ago`;
  return `Last seen ${date.toLocaleDateString()}`;
}
