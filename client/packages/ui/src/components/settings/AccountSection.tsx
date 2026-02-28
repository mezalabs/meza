import { useAuthStore } from '@meza/core';
import { openProfilePane } from '../../stores/tiling.ts';
import { Avatar } from '../shared/Avatar.tsx';

export function AccountSection() {
  const user = useAuthStore((s) => s.user);

  if (!user) return null;

  return (
    <div className="max-w-md space-y-6">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-text-subtle">
        Account
      </h2>

      {/* Avatar + name display */}
      <div className="flex items-center gap-4">
        <Avatar
          avatarUrl={user.avatarUrl}
          displayName={user.displayName || user.username}
          size="xl"
        />
        <div>
          <div className="text-lg font-semibold text-text">
            {user.displayName || user.username}
          </div>
          <div className="text-sm text-text-muted">@{user.username}</div>
        </div>
      </div>

      {/* Username (read-only) */}
      <div className="space-y-1.5">
        <span className="block text-sm font-medium text-text">Username</span>
        <span className="block text-sm text-text-muted">@{user.username}</span>
      </div>

      {/* Email (read-only) */}
      <div className="space-y-1.5">
        <span className="block text-sm font-medium text-text">Email</span>
        <span className="block text-sm text-text-muted">
          Managed via account settings
        </span>
      </div>

      {/* Edit Profile button */}
      <button
        type="button"
        className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-black transition-colors hover:bg-accent-hover"
        onClick={() => openProfilePane(user.id)}
      >
        Edit Profile
      </button>
    </div>
  );
}
