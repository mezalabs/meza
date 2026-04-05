import {
  ChannelType,
  deleteChannel,
  getEffectivePermissions,
  hasPermission,
  Permissions,
  useAuthStore,
  useChannelStore,
  useServerStore,
} from '@meza/core';
import { ArrowLeftIcon } from '@phosphor-icons/react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useMobile } from '../../hooks/useMobile.ts';
import { closeChannelPanes } from '../../stores/tiling.ts';
import { ChannelOverrideEditor } from './ChannelOverrideEditor.tsx';
import { ChannelOverviewSection } from './ChannelOverviewSection.tsx';
import { EffectivePermissionsViewer } from './EffectivePermissionsViewer.tsx';
import { WebhooksSection } from './WebhooksSection.tsx';

interface SectionDef {
  id: string;
  label: string;
  perm: 'manageChannels' | 'manageRoles' | 'manageWebhooks';
  textOnly?: boolean; // only show for text channels
}

const ALL_SECTIONS: SectionDef[] = [
  { id: 'overview', label: 'Overview', perm: 'manageChannels' },
  { id: 'permissions', label: 'Permissions', perm: 'manageRoles' },
  { id: 'effective', label: 'Effective Permissions', perm: 'manageRoles' },
  { id: 'webhooks', label: 'Webhooks', perm: 'manageWebhooks', textOnly: true },
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
  const isMobile = useMobile();
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
  const canManageWebhooks =
    isOwner || hasPermission(callerPerms, Permissions.MANAGE_WEBHOOKS);

  const isTextChannel = channel
    ? channels?.find((c) => c.id === channelId)?.type === ChannelType.TEXT
    : false;

  const visibleSections = useMemo(
    () =>
      ALL_SECTIONS.filter((s) => {
        if (s.textOnly && !isTextChannel) return false;
        switch (s.perm) {
          case 'manageChannels': return canManageChannels;
          case 'manageRoles': return canManageRoles;
          case 'manageWebhooks': return canManageWebhooks;
          default: return false;
        }
      }),
    [canManageChannels, canManageRoles, canManageWebhooks, isTextChannel],
  );

  const [activeSection, setActiveSection] = useState<string>(
    isMobile ? '' : '',
  );

  // Default to first visible section (desktop only — mobile starts on nav list).
  useEffect(() => {
    if (isMobile) return;
    if (
      visibleSections.length > 0 &&
      !visibleSections.some((s) => s.id === activeSection)
    ) {
      setActiveSection(visibleSections[0].id);
    }
  }, [visibleSections, activeSection, isMobile]);

  const activeSectionLabel = visibleSections.find(
    (s) => s.id === activeSection,
  )?.label;

  // Mobile: show nav list or content, not both
  if (isMobile) {
    if (activeSection) {
      return (
        <div className="flex flex-1 min-h-0 flex-col">
          <header className="flex h-12 flex-shrink-0 items-center gap-2 border-b border-border/40 px-2">
            <button
              type="button"
              onClick={() => setActiveSection('')}
              className="p-2 text-text-muted hover:text-text transition-colors"
              aria-label="Back"
            >
              <ArrowLeftIcon size={20} aria-hidden="true" />
            </button>
            <h2 className="flex-1 truncate text-base font-semibold text-text">
              {activeSectionLabel}
            </h2>
          </header>
          <div className="flex-1 overflow-y-auto p-4">
            {renderChannelSettingsContent(
              activeSection,
              serverId,
              channelId,
              channel,
            )}
          </div>
        </div>
      );
    }

    return (
      <nav
        className="flex flex-1 flex-col gap-1 overflow-y-auto p-3"
        aria-label="Channel settings sections"
      >
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-text-subtle">
          Channel Settings
        </h2>
        {visibleSections.map((s) => (
          <button
            key={s.id}
            type="button"
            className={`rounded-md px-3 py-2.5 text-left text-sm transition-colors ${
              s.id === 'danger'
                ? 'mt-auto text-error hover:bg-bg-surface'
                : 'text-text-muted hover:bg-bg-surface hover:text-text'
            }`}
            onClick={() => setActiveSection(s.id)}
          >
            {s.label}
          </button>
        ))}
      </nav>
    );
  }

  // Desktop: side-by-side layout
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
        {renderChannelSettingsContent(
          activeSection,
          serverId,
          channelId,
          channel,
        )}
      </div>
    </div>
  );
}

function renderChannelSettingsContent(
  section: string,
  serverId: string,
  channelId: string,
  channel: { name: string; isDefault: boolean } | undefined,
) {
  switch (section) {
    case 'overview':
      return (
        <ChannelOverviewSection serverId={serverId} channelId={channelId} />
      );
    case 'permissions':
      return (
        <ChannelOverrideEditor serverId={serverId} channelId={channelId} />
      );
    case 'effective':
      return (
        <EffectivePermissionsViewer serverId={serverId} channelId={channelId} />
      );
    case 'webhooks':
      return (
        <WebhooksSection serverId={serverId} channelId={channelId} />
      );
    case 'danger':
      return channel ? (
        <DangerZoneSection
          channelId={channelId}
          channelName={channel.name}
          isDefault={channel.isDefault}
        />
      ) : null;
    default:
      return null;
  }
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
