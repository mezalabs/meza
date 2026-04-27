import {
  deleteChannelGroup,
  getEffectivePermissions,
  hasPermission,
  Permissions,
  useAuthStore,
  useChannelGroupStore,
  useServerStore,
} from '@meza/core';
import { ArrowLeftIcon } from '@phosphor-icons/react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useMobile } from '../../hooks/useMobile.ts';
import { closeCategoryPanes } from '../../stores/tiling.ts';
import { CategoryOverviewSection } from './CategoryOverviewSection.tsx';
import { ChannelOverrideEditor } from './ChannelOverrideEditor.tsx';

interface SectionDef {
  id: string;
  label: string;
  // Delete requires both manageChannels and manageRoles (backend enforced).
  perm: 'manageChannels' | 'manageRoles' | 'manageChannelsAndRoles';
}

const ALL_SECTIONS: SectionDef[] = [
  { id: 'overview', label: 'Overview', perm: 'manageChannels' },
  { id: 'permissions', label: 'Permissions', perm: 'manageRoles' },
  { id: 'danger', label: 'Danger Zone', perm: 'manageChannelsAndRoles' },
];

interface CategorySettingsViewProps {
  serverId: string;
  channelGroupId: string;
}

export function CategorySettingsView({
  serverId,
  channelGroupId,
}: CategorySettingsViewProps) {
  const isMobile = useMobile();
  const userId = useAuthStore((s) => s.user?.id);
  const server = useServerStore((s) => s.servers[serverId]);
  const groups = useChannelGroupStore((s) => s.byServer[serverId]);
  const group = useMemo(
    () => groups?.find((g) => g.id === channelGroupId),
    [groups, channelGroupId],
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
      ALL_SECTIONS.filter((s) => {
        switch (s.perm) {
          case 'manageChannels':
            return canManageChannels;
          case 'manageRoles':
            return canManageRoles;
          case 'manageChannelsAndRoles':
            return canManageChannels && canManageRoles;
          default:
            return false;
        }
      }),
    [canManageChannels, canManageRoles],
  );

  const [activeSection, setActiveSection] = useState<string>('');

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
            {renderCategorySettingsContent(
              activeSection,
              serverId,
              channelGroupId,
              group,
            )}
          </div>
        </div>
      );
    }

    return (
      <nav
        className="flex flex-1 flex-col gap-1 overflow-y-auto p-3"
        aria-label="Category settings sections"
      >
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-text-subtle">
          Category Settings
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

  return (
    <div
      className="flex flex-1 min-h-0 min-w-0"
      data-server-id={serverId}
      data-channel-group-id={channelGroupId}
    >
      <nav
        className="flex w-48 flex-shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-border p-3"
        aria-label="Category settings sections"
      >
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-text-subtle">
          Category Settings
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

      <div className="flex-1 overflow-y-auto p-6">
        {renderCategorySettingsContent(
          activeSection,
          serverId,
          channelGroupId,
          group,
        )}
      </div>
    </div>
  );
}

function renderCategorySettingsContent(
  section: string,
  serverId: string,
  channelGroupId: string,
  group: { name: string } | undefined,
) {
  switch (section) {
    case 'overview':
      return (
        <CategoryOverviewSection
          serverId={serverId}
          channelGroupId={channelGroupId}
        />
      );
    case 'permissions':
      return (
        <ChannelOverrideEditor
          serverId={serverId}
          channelGroupId={channelGroupId}
        />
      );
    case 'danger':
      return group ? (
        <DangerZoneSection
          channelGroupId={channelGroupId}
          categoryName={group.name}
        />
      ) : null;
    default:
      return null;
  }
}

function DangerZoneSection({
  channelGroupId,
  categoryName,
}: {
  channelGroupId: string;
  categoryName: string;
}) {
  const [showConfirm, setShowConfirm] = useState(false);
  const [confirmName, setConfirmName] = useState('');
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState('');

  // Trim + NFC-normalize both sides so a stored name with stray whitespace or
  // unicode form differences doesn't lock the user out of confirming.
  const canDelete =
    confirmName.trim().normalize('NFC') ===
    categoryName.trim().normalize('NFC');

  const handleDelete = useCallback(async () => {
    setIsDeleting(true);
    setError('');
    try {
      await deleteChannelGroup(channelGroupId);
      closeCategoryPanes(channelGroupId);
    } catch {
      setError('Failed to delete category');
      setIsDeleting(false);
    }
  }, [channelGroupId]);

  return (
    <div className="max-w-lg space-y-6">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-error">
        Danger Zone
      </h2>

      <div className="rounded-lg border border-error/30 p-4">
        <h3 className="text-sm font-medium text-text">Delete Category</h3>
        <p className="mt-1 text-xs text-text-muted">
          Permanently delete the {categoryName} category. Channels in this
          category will be moved out of any category. This action cannot be
          undone.
        </p>

        {showConfirm ? (
          <div className="mt-3 space-y-3">
            <div className="space-y-1.5">
              <label
                htmlFor="confirm-delete-category"
                className="block text-xs text-text-muted"
              >
                Type <strong className="text-text">{categoryName}</strong> to
                confirm
              </label>
              <input
                id="confirm-delete-category"
                type="text"
                value={confirmName}
                onChange={(e) => setConfirmName(e.target.value)}
                autoComplete="off"
                className="w-full rounded-md border border-border bg-bg-surface px-3 py-2 text-sm text-text placeholder:text-text-subtle focus:border-error focus:outline-none"
                placeholder={categoryName}
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
                {isDeleting ? 'Deleting...' : 'Delete Category'}
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
            Delete Category
          </button>
        )}
      </div>
    </div>
  );
}
