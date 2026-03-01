import type { PermCategory } from '@meza/core';
import {
  CATEGORY_META,
  getEffectivePermissions,
  hasPermission,
  PERMISSION_INFO,
  PERMISSIONS_BY_CATEGORY,
  Permissions,
  useAuthStore,
  useMemberStore,
} from '@meza/core';
import { CaretRightIcon, CheckIcon, XIcon } from '@phosphor-icons/react';
import { useEffect, useMemo, useState } from 'react';

/** Order in which categories render. */
const CATEGORY_ORDER: PermCategory[] = [
  'general',
  'text',
  'voice',
  'moderation',
  'server',
];

interface EffectivePermissionsViewerProps {
  serverId: string;
  channelId: string;
  userId?: string;
}

export function EffectivePermissionsViewer({
  serverId,
  channelId,
  userId: initialUserId,
}: EffectivePermissionsViewerProps) {
  const currentUserId = useAuthStore((s) => s.user?.id);
  const members = useMemberStore((s) => s.byServer[serverId]);
  const [selectedUserId, setSelectedUserId] = useState(initialUserId ?? '');
  const [memberSearch, setMemberSearch] = useState('');
  const [permissions, setPermissions] = useState<bigint | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The userId to query — empty string means "self" (caller).
  const effectiveUserId = selectedUserId || undefined;

  useEffect(() => {
    let ignore = false;
    setPermissions(null);
    setError(null);

    getEffectivePermissions(serverId, channelId, effectiveUserId)
      .then((result) => {
        if (!ignore) setPermissions(result);
      })
      .catch((err) => {
        if (!ignore) {
          setError(
            err instanceof Error ? err.message : 'Failed to load permissions',
          );
        }
      });

    return () => {
      ignore = true;
    };
  }, [serverId, channelId, effectiveUserId]);

  const filteredMembers = useMemo(() => {
    if (!members) return [];
    const q = memberSearch.toLowerCase();
    return members
      .filter(
        (m) =>
          m.userId !== currentUserId &&
          (m.nickname || m.userId).toLowerCase().includes(q),
      )
      .slice(0, 20);
  }, [members, memberSearch, currentUserId]);

  const selectedLabel = useMemo(() => {
    if (!selectedUserId) return null;
    const m = members?.find((m) => m.userId === selectedUserId);
    return m ? m.nickname || m.userId.slice(0, 8) : selectedUserId.slice(0, 8);
  }, [selectedUserId, members]);

  return (
    <div className="max-w-lg space-y-4">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-text-subtle">
        Effective Permissions
      </h2>

      {/* Member picker */}
      <div className="space-y-1.5">
        <label
          htmlFor="effective-member"
          className="block text-sm font-medium text-text"
        >
          View as member
        </label>
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <input
              id="effective-member"
              type="text"
              value={memberSearch}
              onChange={(e) => setMemberSearch(e.target.value)}
              placeholder={selectedLabel ?? 'Yourself (default)'}
              autoComplete="off"
              className="w-full rounded-md border border-border bg-bg-surface px-3 py-2 text-sm text-text placeholder:text-text-subtle focus:border-accent focus:outline-none"
            />
            {memberSearch && (
              <div className="absolute z-10 mt-1 max-h-48 w-full overflow-y-auto rounded-md border border-border bg-bg-surface shadow-lg">
                {filteredMembers.length === 0 ? (
                  <p className="px-3 py-2 text-xs text-text-muted">
                    No members found
                  </p>
                ) : (
                  filteredMembers.map((m) => (
                    <button
                      key={m.userId}
                      type="button"
                      className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-text hover:bg-bg-elevated"
                      onClick={() => {
                        setSelectedUserId(m.userId);
                        setMemberSearch('');
                      }}
                    >
                      <span className="truncate">
                        {m.nickname || m.userId.slice(0, 8)}
                      </span>
                    </button>
                  ))
                )}
              </div>
            )}
          </div>
          {selectedUserId && (
            <button
              type="button"
              onClick={() => {
                setSelectedUserId('');
                setMemberSearch('');
              }}
              className="shrink-0 rounded-md px-2 py-2 text-xs text-text-muted hover:text-text"
            >
              Reset
            </button>
          )}
        </div>
        {selectedLabel && (
          <p className="text-xs text-text-muted">
            Showing permissions for{' '}
            <strong className="text-text">{selectedLabel}</strong>
          </p>
        )}
      </div>

      {error ? (
        <p className="text-sm text-error">{error}</p>
      ) : permissions === null ? (
        <p className="text-sm text-text-muted">Loading permissions...</p>
      ) : (
        <div className="flex flex-col gap-1">
          {CATEGORY_ORDER.map((cat) => (
            <PermissionCategoryView
              key={cat}
              category={cat}
              resolved={permissions}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Permission Category (collapsible <details>) — read-only
 * --------------------------------------------------------------------------- */

function PermissionCategoryView({
  category,
  resolved,
}: {
  category: PermCategory;
  resolved: bigint;
}) {
  const meta = CATEGORY_META[category];
  const permKeys = PERMISSIONS_BY_CATEGORY[category];

  // Count how many permissions in this category are granted.
  let grantedCount = 0;
  for (const key of permKeys) {
    const bit = Permissions[key as keyof typeof Permissions];
    if (bit !== undefined && hasPermission(resolved, bit)) {
      grantedCount++;
    }
  }

  return (
    <details className="group rounded-md border border-border bg-bg-surface">
      <summary className="flex cursor-pointer select-none items-center gap-2 px-3 py-2 text-sm font-medium text-text">
        <CaretRightIcon
          size={16}
          className="shrink-0 text-text-muted transition-transform group-open:rotate-90"
          aria-hidden="true"
        />
        <span>{meta.label}</span>
        <span className="text-xs font-normal text-text-subtle">
          {grantedCount}/{permKeys.length} granted
        </span>
      </summary>
      <div className="flex flex-col gap-0.5 px-3 pb-3">
        {permKeys.map((key) => {
          const info = PERMISSION_INFO[key];
          const bit = Permissions[key as keyof typeof Permissions];
          if (!info || bit === undefined) return null;
          const granted = hasPermission(resolved, bit);

          return (
            <div
              key={key}
              className="flex items-center justify-between rounded-md px-2 py-2"
            >
              <div className="flex-1 pr-4">
                <div className="text-sm font-medium text-text">{info.name}</div>
                <div className="text-xs text-text-muted">
                  {info.description}
                </div>
              </div>
              {granted ? (
                <CheckIcon
                  size={20}
                  className="shrink-0 text-success"
                  role="img"
                  aria-label="Granted"
                />
              ) : (
                <XIcon
                  weight="regular"
                  size={20}
                  className="shrink-0 text-text-subtle"
                  role="img"
                  aria-label="Denied"
                />
              )}
            </div>
          );
        })}
      </div>
    </details>
  );
}
