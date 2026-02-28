import {
  deleteChannel,
  getEffectivePermissions,
  hasPermission,
  Permissions,
  useAuthStore,
  useChannelStore,
  useServerStore,
} from '@meza/core';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { closeChannelPanes } from '../../stores/tiling.ts';
import { ChannelOverrideEditor } from './ChannelOverrideEditor.tsx';
import { ChannelOverviewSection } from './ChannelOverviewSection.tsx';
import { EffectivePermissionsViewer } from './EffectivePermissionsViewer.tsx';

interface SectionDef {
  id: string;
  label: string;
  perm: 'manageChannels' | 'manageRoles';
}

const ALL_SECTIONS: SectionDef[] = [
  { id: 'overview', label: 'Overview', perm: 'manageChannels' },
  { id: 'permissions', label: 'Permissions', perm: 'manageRoles' },
  { id: 'effective', label: 'Effective Permissions', perm: 'manageRoles' },
  { id: 'danger', label: 'Danger Zone', perm: 'manageChannels' },
];

interface ChannelSettingsViewProps {
  serverId: string;
  channelId: string;
}

export function ChannelSettingsView({
  serverId,
  channelId,
}: ChannelSettingsViewProps) {
  const userId = useAuthStore((s) => s.user?.id);
  const server = useServerStore((s) => s.servers[serverId]);
  const channels = useChannelStore((s) => s.byServer[serverId]);
  const channel = useMemo(
    () => channels?.find((c) => c.id === channelId),
    [channels, channelId],
  );

  const [callerPerms, setCallerPerms] = useState(0n);

  useEffect(() => {
    if (!serverId) return;
    getEffectivePermissions(serverId)
      .then(setCallerPerms)
      .catch(() => {});
  }, [serverId]);

  const isOwner = server?.ownerId === userId;
  const canManageChannels =
    isOwner || hasPermission(callerPerms, Permissions.MANAGE_CHANNELS);
  const canManageRoles =
    isOwner || hasPermission(callerPerms, Permissions.MANAGE_ROLES);

  const visibleSections = useMemo(
    () =>
      ALL_SECTIONS.filter((s) =>
        s.perm === 'manageChannels' ? canManageChannels : canManageRoles,
      ),
    [canManageChannels, canManageRoles],
  );

  const [activeSection, setActiveSection] = useState<string>('');

  // Default to first visible section.
  useEffect(() => {
    if (
      visibleSections.length > 0 &&
      !visibleSections.some((s) => s.id === activeSection)
    ) {
      setActiveSection(visibleSections[0].id);
    }
  }, [visibleSections, activeSection]);

  return (
    <div
      className="flex flex-1 min-h-0 min-w-0"
      data-server-id={serverId}
      data-channel-id={channelId}
    >
      {/* Settings nav sidebar */}
      <nav
        className="flex w-48 flex-shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-border p-3"
        aria-label="Channel settings sections"
      >
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-text-subtle">
          Channel Settings
        </h2>
        {visibleSections.map((s) => (
          <button
            key={s.id}
            type="button"
            className={`rounded-md px-2 py-1.5 text-left text-sm transition-colors ${
              activeSection === s.id
                ? 'bg-accent-subtle text-text'
                : 'text-text-muted hover:bg-bg-surface hover:text-text'
            } ${s.id === 'danger' ? 'mt-auto text-error' : ''}`}
            onClick={() => setActiveSection(s.id)}
          >
            {s.label}
          </button>
        ))}
      </nav>

      {/* Settings content area */}
      <div className="flex-1 overflow-y-auto p-6">
        {activeSection === 'overview' && (
          <ChannelOverviewSection serverId={serverId} channelId={channelId} />
        )}
        {activeSection === 'permissions' && (
          <ChannelOverrideEditor serverId={serverId} channelId={channelId} />
        )}
        {activeSection === 'effective' && (
          <EffectivePermissionsViewer
            serverId={serverId}
            channelId={channelId}
          />
        )}
        {activeSection === 'danger' && channel && (
          <DangerZoneSection
            channelId={channelId}
            channelName={channel.name}
            isDefault={channel.isDefault}
          />
        )}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * DangerZoneSection — channel deletion with name confirmation
 * --------------------------------------------------------------------------- */

function DangerZoneSection({
  channelId,
  channelName,
  isDefault,
}: {
  channelId: string;
  channelName: string;
  isDefault: boolean;
}) {
  const [showConfirm, setShowConfirm] = useState(false);
  const [confirmName, setConfirmName] = useState('');
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState('');

  const canDelete = confirmName === channelName;

  const handleDelete = useCallback(async () => {
    setIsDeleting(true);
    setError('');
    try {
      await deleteChannel(channelId);
      closeChannelPanes(channelId);
    } catch {
      setError('Failed to delete channel');
      setIsDeleting(false);
    }
  }, [channelId]);

  return (
    <div className="max-w-lg space-y-6">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-error">
        Danger Zone
      </h2>

      <div className="rounded-lg border border-error/30 p-4">
        <h3 className="text-sm font-medium text-text">Delete Channel</h3>
        <p className="mt-1 text-xs text-text-muted">
          Permanently delete #{channelName} and all its messages. This action
          cannot be undone.
        </p>

        {isDefault ? (
          <p className="mt-3 text-xs text-text-subtle">
            The default channel cannot be deleted. Set another channel as
            default first.
          </p>
        ) : showConfirm ? (
          <div className="mt-3 space-y-3">
            <div className="space-y-1.5">
              <label
                htmlFor="confirm-delete"
                className="block text-xs text-text-muted"
              >
                Type <strong className="text-text">{channelName}</strong> to
                confirm
              </label>
              <input
                id="confirm-delete"
                type="text"
                value={confirmName}
                onChange={(e) => setConfirmName(e.target.value)}
                autoComplete="off"
                className="w-full rounded-md border border-border bg-bg-surface px-3 py-2 text-sm text-text placeholder:text-text-subtle focus:border-error focus:outline-none"
                placeholder={channelName}
              />
            </div>
            {error && <p className="text-xs text-error">{error}</p>}
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={!canDelete || isDeleting}
                onClick={handleDelete}
                className="rounded-md bg-error px-3 py-1.5 text-sm font-medium text-white hover:bg-error/80 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isDeleting ? 'Deleting...' : 'Delete Channel'}
              </button>
              <button
                type="button"
                disabled={isDeleting}
                onClick={() => {
                  setShowConfirm(false);
                  setConfirmName('');
                  setError('');
                }}
                className="rounded-md px-3 py-1.5 text-sm text-text-muted hover:text-text"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setShowConfirm(true)}
            className="mt-3 rounded-md bg-error px-3 py-1.5 text-sm font-medium text-white hover:bg-error/80"
          >
            Delete Channel
          </button>
        )}
      </div>
    </div>
  );
}
