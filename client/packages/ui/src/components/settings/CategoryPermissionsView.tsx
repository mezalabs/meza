import { useChannelGroupStore } from '@meza/core';
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

  if (isMobile) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex-1 overflow-y-auto p-4">
          <ChannelOverrideEditor
            serverId={serverId}
            channelGroupId={channelGroupId}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 min-w-0">
      {/* Settings nav sidebar */}
      <nav
        className="flex w-48 flex-shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-border p-3"
        aria-label="Category settings sections"
      >
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-text-subtle">
          {group?.name ?? 'Category'}
        </h2>
        <button
          type="button"
          className="rounded-md bg-accent-subtle px-2 py-1.5 text-left text-sm text-text transition-colors"
        >
          Permissions
        </button>
      </nav>

      {/* Settings content area */}
      <div className="flex-1 overflow-y-auto p-6">
        <ChannelOverrideEditor
          serverId={serverId}
          channelGroupId={channelGroupId}
        />
      </div>
    </div>
  );
}
