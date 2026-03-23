import {
  ArrowsClockwiseIcon,
  InfoIcon,
  WarningIcon,
} from '@phosphor-icons/react';

interface SyncStatusBannerProps {
  channelId: string;
  channelGroupId?: string;
  permissionsSynced?: boolean;
  categoryName?: string;
  onSync: () => void;
  isSyncing?: boolean;
}

export function SyncStatusBanner({
  channelGroupId,
  permissionsSynced,
  categoryName,
  onSync,
  isSyncing,
}: SyncStatusBannerProps) {
  // No category assigned — nothing to show
  if (!channelGroupId) return null;

  const displayName = categoryName || 'category';

  if (permissionsSynced) {
    return (
      <div className="mb-4 flex items-center gap-2 rounded-md border border-accent/30 bg-accent/5 px-3 py-2">
        <InfoIcon
          size={18}
          className="shrink-0 text-accent"
          aria-hidden="true"
        />
        <span className="text-sm text-text">
          Permissions synced with <strong>{displayName}</strong>
        </span>
      </div>
    );
  }

  return (
    <div className="mb-4 flex items-center justify-between gap-2 rounded-md border border-warning/30 bg-warning/5 px-3 py-2">
      <div className="flex items-center gap-2">
        <WarningIcon
          size={18}
          className="shrink-0 text-warning"
          aria-hidden="true"
        />
        <span className="text-sm text-warning">
          Permissions diverged from <strong>{displayName}</strong>
        </span>
      </div>
      <button
        type="button"
        disabled={isSyncing}
        onClick={onSync}
        className="flex items-center gap-1.5 rounded-md bg-warning/10 px-3 py-1.5 text-sm font-medium text-warning hover:bg-warning/20 disabled:opacity-50"
      >
        <ArrowsClockwiseIcon
          size={14}
          className={isSyncing ? 'animate-spin' : ''}
          aria-hidden="true"
        />
        {isSyncing ? 'Syncing...' : 'Sync Permissions'}
      </button>
    </div>
  );
}
