import { useChannelGroupStore, useChannelStore } from '@meza/core';
import {
  ArrowLeftIcon,
  ArrowsClockwiseIcon,
  LinkBreakIcon,
} from '@phosphor-icons/react';
import { useMemo } from 'react';
import { useMobile } from '../../hooks/useMobile.ts';
import { ChannelOverrideEditor } from './ChannelOverrideEditor.tsx';

interface CategoryPermissionsViewProps {
  serverId: string;
  channelGroupId: string;
}

export function CategoryPermissionsView({
  serverId,
  channelGroupId,
}: CategoryPermissionsViewProps) {
  const isMobile = useMobile();
  const groups = useChannelGroupStore((s) => s.byServer[serverId]);
  const group = useMemo(
    () => groups?.find((g) => g.id === channelGroupId),
    [groups, channelGroupId],
  );
  const channels = useChannelStore((s) => s.byServer[serverId]);
  const groupChannels = useMemo(
    () => channels?.filter((c) => c.channelGroupId === channelGroupId) ?? [],
    [channels, channelGroupId],
  );
  const syncedCount = groupChannels.filter((c) => c.permissionsSynced).length;
  const divergedCount = groupChannels.length - syncedCount;

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      {/* Sidebar */}
      <div className="flex w-48 shrink-0 flex-col border-r border-border bg-bg-base p-3">
        <button
          type="button"
          onClick={() => window.history.back()}
          className="mb-4 flex items-center gap-1 text-sm text-text-muted hover:text-text transition-colors"
        >
          <ArrowLeftIcon size={14} />
          Back
        </button>
        <h2 className="mb-1 truncate text-sm font-semibold text-text">
          {group?.name ?? 'Category'}
        </h2>
        <p className="mb-3 text-xs text-text-muted">
          {groupChannels.length}{' '}
          {groupChannels.length === 1 ? 'channel' : 'channels'}
        </p>
        <div className="rounded-md bg-accent-subtle px-2 py-1.5 text-sm font-medium text-text">
          Permissions
        </div>

        {/* Channel sync summary */}
        {groupChannels.length > 0 && (
          <div className="mt-4 flex flex-col gap-1.5">
            <span className="text-xs font-semibold uppercase tracking-wide text-text-subtle">
              Channels
            </span>
            {syncedCount > 0 && (
              <div className="flex items-center gap-1.5 text-xs text-text-muted">
                <ArrowsClockwiseIcon size={12} className="text-accent-muted" />
                {syncedCount} synced
              </div>
            )}
            {divergedCount > 0 && (
              <div className="flex items-center gap-1.5 text-xs text-text-muted">
                <LinkBreakIcon size={12} className="text-warning" />
                {divergedCount} diverged
              </div>
            )}
          </div>
        )}
      </div>

      {/* Content */}
      <div className={`flex-1 overflow-y-auto ${isMobile ? 'p-4' : 'p-6'}`}>
        <ChannelOverrideEditor
          serverId={serverId}
          channelGroupId={channelGroupId}
        />
      </div>
    </div>
  );
}
