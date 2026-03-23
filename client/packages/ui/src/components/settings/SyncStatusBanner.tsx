import {
  ArrowsClockwiseIcon,
  LinkBreakIcon,
  LinkIcon,
} from '@phosphor-icons/react';

interface SyncStatusBannerProps {
  channelGroupId?: string;
  permissionsSynced?: boolean;
  categoryName?: string;
  onSync: () => void;
  isSyncing?: boolean;
  channelOverrideCount?: number;
}

export function SyncStatusBanner({
  channelGroupId,
  permissionsSynced,
  categoryName,
  onSync,
  isSyncing,
  channelOverrideCount,
}: SyncStatusBannerProps) {
  // No category assigned — nothing to show
  if (!channelGroupId) return null;

  const displayName = categoryName || 'category';

  if (permissionsSynced) {
    return (
      <div className="mb-4 flex items-start gap-3 rounded-md border border-accent/20 bg-accent/5 px-3.5 py-2.5">
        <LinkIcon
          size={16}
          weight="bold"
          className="mt-0.5 shrink-0 text-accent-muted"
          aria-hidden="true"
        />
        <div className="flex-1">
          <p className="text-sm font-medium text-text">
            Synced with {displayName}
          </p>
          <p className="mt-0.5 text-xs text-text-muted">
            Permission changes to the category automatically apply to this
            channel. Add an override below to diverge.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="mb-4 flex items-start justify-between gap-3 rounded-md border border-warning/20 bg-warning/5 px-3.5 py-2.5">
      <div className="flex items-start gap-3">
        <LinkBreakIcon
          size={16}
          weight="bold"
          className="mt-0.5 shrink-0 text-warning"
          aria-hidden="true"
        />
        <div>
          <p className="text-sm font-medium text-text">
            Diverged from {displayName}
          </p>
          <p className="mt-0.5 text-xs text-text-muted">
            This channel has{' '}
            {channelOverrideCount !== undefined && channelOverrideCount > 0
              ? `${channelOverrideCount} custom ${channelOverrideCount === 1 ? 'override' : 'overrides'}`
              : 'custom overrides'}{' '}
            that differ from the category.
          </p>
        </div>
      </div>
      <button
        type="button"
        disabled={isSyncing}
        onClick={onSync}
        className="mt-0.5 flex shrink-0 items-center gap-1.5 rounded-md border border-warning/30 px-2.5 py-1 text-xs font-medium text-warning transition-colors hover:bg-warning/10 disabled:opacity-50"
      >
        <ArrowsClockwiseIcon
          size={12}
          className={isSyncing ? 'animate-spin' : ''}
          aria-hidden="true"
        />
        {isSyncing ? 'Syncing...' : 'Sync'}
      </button>
    </div>
  );
}
