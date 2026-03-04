import type { PermCategory } from '@meza/core';
import {
  CATEGORY_META,
  CHANNEL_SCOPED_PERMISSIONS,
  CHANNEL_TYPE_CATEGORIES,
  ChannelType,
  deletePermissionOverride,
  getEffectivePermissions,
  hasPermission,
  listPermissionOverrides,
  listRoles,
  PERMISSION_INFO,
  PERMISSIONS_BY_CATEGORY,
  Permissions,
  setPermissionOverride,
  useAuthStore,
  useChannelStore,
  useGatewayStore,
  useMemberStore,
  usePermissionOverrideStore,
  useRoleStore,
  useServerStore,
} from '@meza/core';
import {
  CaretRightIcon,
  CheckIcon,
  MinusIcon,
  XIcon,
} from '@phosphor-icons/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { roleColorHex } from '../../utils/color.ts';

/* ---------------------------------------------------------------------------
 * Types
 * --------------------------------------------------------------------------- */

type TriState = 'allow' | 'neutral' | 'deny';

interface ChannelOverrideEditorProps {
  serverId: string;
  channelId: string;
}

/* ---------------------------------------------------------------------------
 * usePermissionEditor — manages conversion between allow/deny bigints and
 * per-permission tri-state for one role override.
 * --------------------------------------------------------------------------- */

function usePermissionEditor(initialAllow: bigint, initialDeny: bigint) {
  const [allow, setAllow] = useState(initialAllow);
  const [deny, setDeny] = useState(initialDeny);
  const [externalChange, setExternalChange] = useState(false);
  const allowRef = useRef(allow);
  const denyRef = useRef(deny);
  allowRef.current = allow;
  denyRef.current = deny;

  // Sync when the initial values change (e.g. after save or switching role).
  // Only auto-sync if the user has no unsaved edits; otherwise show a warning.
  useEffect(() => {
    const dirty =
      allowRef.current !== initialAllow || denyRef.current !== initialDeny;
    if (dirty) {
      setExternalChange(true);
    } else {
      setAllow(initialAllow);
      setDeny(initialDeny);
    }
  }, [initialAllow, initialDeny]);

  const getState = useCallback(
    (key: string): TriState => {
      const bit = Permissions[key as keyof typeof Permissions];
      if (bit === undefined) return 'neutral';
      if ((allow & bit) !== 0n) return 'allow';
      if ((deny & bit) !== 0n) return 'deny';
      return 'neutral';
    },
    [allow, deny],
  );

  const setState = useCallback((key: string, state: TriState) => {
    const bit = Permissions[key as keyof typeof Permissions];
    if (bit === undefined) return;
    setAllow((prev) => {
      const cleared = prev & ~bit;
      return state === 'allow' ? cleared | bit : cleared;
    });
    setDeny((prev) => {
      const cleared = prev & ~bit;
      return state === 'deny' ? cleared | bit : cleared;
    });
  }, []);

  const isDirty = allow !== initialAllow || deny !== initialDeny;

  const reset = useCallback(() => {
    setAllow(initialAllow);
    setDeny(initialDeny);
    setExternalChange(false);
  }, [initialAllow, initialDeny]);

  const acceptExternal = useCallback(() => {
    setAllow(initialAllow);
    setDeny(initialDeny);
    setExternalChange(false);
  }, [initialAllow, initialDeny]);

  return {
    allow,
    deny,
    getState,
    setState,
    isDirty,
    reset,
    externalChange,
    acceptExternal,
  };
}

/* ---------------------------------------------------------------------------
 * TriStateToggle — accessible radiogroup with three states.
 * --------------------------------------------------------------------------- */

function TriStateToggle({
  value,
  onChange,
  disabled,
  label,
}: {
  value: TriState;
  onChange: (next: TriState) => void;
  disabled?: boolean;
  label: string;
}) {
  const states: TriState[] = ['deny', 'neutral', 'allow'];

  function handleKeyDown(e: React.KeyboardEvent) {
    if (disabled) return;
    const idx = states.indexOf(value);
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      onChange(states[(idx + 1) % states.length]);
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      onChange(states[(idx + 2) % states.length]);
    }
  }

  return (
    <div
      role="radiogroup"
      aria-label={`${label} override`}
      className="flex items-center gap-0.5"
      onKeyDown={handleKeyDown}
    >
      {/* Deny */}
      {/* biome-ignore lint/a11y/useSemanticElements: tri-state toggle requires custom radio buttons */}
      <button
        type="button"
        role="radio"
        aria-checked={value === 'deny'}
        aria-label="Deny"
        disabled={disabled}
        onClick={() => onChange(value === 'deny' ? 'neutral' : 'deny')}
        className={`flex h-7 w-7 items-center justify-center rounded-l-md text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
          value === 'deny'
            ? 'bg-error/20 text-error'
            : 'bg-bg-elevated text-text-subtle hover:text-text'
        }`}
        tabIndex={value === 'deny' ? 0 : -1}
      >
        <XIcon weight="regular" size={14} aria-hidden="true" />
      </button>

      {/* Neutral */}
      {/* biome-ignore lint/a11y/useSemanticElements: tri-state toggle requires custom radio buttons */}
      <button
        type="button"
        role="radio"
        aria-checked={value === 'neutral'}
        aria-label="Neutral"
        disabled={disabled}
        onClick={() => onChange('neutral')}
        className={`flex h-7 w-7 items-center justify-center text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
          value === 'neutral'
            ? 'bg-bg-elevated text-text'
            : 'bg-bg-elevated text-text-subtle hover:text-text'
        }`}
        tabIndex={value === 'neutral' ? 0 : -1}
      >
        <MinusIcon size={14} aria-hidden="true" />
      </button>

      {/* Allow */}
      {/* biome-ignore lint/a11y/useSemanticElements: tri-state toggle requires custom radio buttons */}
      <button
        type="button"
        role="radio"
        aria-checked={value === 'allow'}
        aria-label="Allow"
        disabled={disabled}
        onClick={() => onChange(value === 'allow' ? 'neutral' : 'allow')}
        className={`flex h-7 w-7 items-center justify-center rounded-r-md text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
          value === 'allow'
            ? 'bg-success/20 text-success'
            : 'bg-bg-elevated text-text-subtle hover:text-text'
        }`}
        tabIndex={value === 'allow' ? 0 : -1}
      >
        <CheckIcon size={14} aria-hidden="true" />
      </button>
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * OverrideCategorySection — collapsible <details> for a permission category
 * --------------------------------------------------------------------------- */

function OverrideCategorySection({
  category,
  getState,
  setState,
  callerHasPerm,
  disabled,
}: {
  category: PermCategory;
  getState: (key: string) => TriState;
  setState: (key: string, state: TriState) => void;
  callerHasPerm: (perm: bigint) => boolean;
  disabled: boolean;
}) {
  const meta = CATEGORY_META[category];
  const allKeys = PERMISSIONS_BY_CATEGORY[category];
  // Only include channel-scoped permissions.
  const permKeys = allKeys.filter((key) => {
    const bit = Permissions[key as keyof typeof Permissions];
    return bit !== undefined && (CHANNEL_SCOPED_PERMISSIONS & bit) !== 0n;
  });

  if (permKeys.length === 0) return null;

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
          {permKeys.length}{' '}
          {permKeys.length === 1 ? 'permission' : 'permissions'}
        </span>
      </summary>
      <div className="flex flex-col gap-0.5 px-3 pb-3">
        {permKeys.map((key) => {
          const info = PERMISSION_INFO[key];
          const bit = Permissions[key as keyof typeof Permissions];
          if (!info || bit === undefined) return null;
          const canToggle = callerHasPerm(bit);

          return (
            <div
              key={key}
              className={`flex items-center justify-between rounded-md px-2 py-2 ${
                canToggle ? '' : 'pointer-events-none opacity-40'
              }`}
              title={canToggle ? undefined : 'You do not have this permission'}
            >
              <div className="flex-1 pr-4">
                <div className="text-sm font-medium text-text">{info.name}</div>
                <div className="text-xs text-text-muted">
                  {info.description}
                </div>
              </div>
              <TriStateToggle
                value={getState(key)}
                onChange={(next) => setState(key, next)}
                disabled={disabled || !canToggle}
                label={info.name}
              />
            </div>
          );
        })}
      </div>
    </details>
  );
}

/* ---------------------------------------------------------------------------
 * RoleOverridePanel — editor for a single role's overrides
 * --------------------------------------------------------------------------- */

function RoleOverridePanel({
  channelId,
  roleId,
  roleName,
  roleColor,
  initialAllow,
  initialDeny,
  categories,
  callerHasPerm,
  onRemove,
  onSaved,
}: {
  channelId: string;
  roleId: string;
  roleName: string;
  roleColor: number;
  initialAllow: bigint;
  initialDeny: bigint;
  categories: PermCategory[];
  callerHasPerm: (perm: bigint) => boolean;
  onRemove: () => void;
  onSaved: () => void;
}) {
  const {
    allow,
    deny,
    getState,
    setState,
    isDirty,
    reset,
    externalChange,
    acceptExternal,
  } = usePermissionEditor(initialAllow, initialDeny);
  const [isSaving, setIsSaving] = useState(false);
  const [isRemoving, setIsRemoving] = useState(false);
  const [removeConfirm, setRemoveConfirm] = useState(false);
  const [error, setError] = useState('');

  async function handleSave() {
    setIsSaving(true);
    setError('');
    try {
      const override = await setPermissionOverride(
        channelId,
        roleId,
        allow,
        deny,
      );
      if (override) {
        usePermissionOverrideStore
          .getState()
          .upsertOverride(channelId, override);
      }
      onSaved();
    } catch {
      setError('Failed to save override');
    } finally {
      setIsSaving(false);
    }
  }

  async function handleRemove() {
    setIsRemoving(true);
    setError('');
    try {
      await deletePermissionOverride(channelId, roleId);
      usePermissionOverrideStore.getState().removeOverride(channelId, roleId);
      onRemove();
    } catch {
      setError('Failed to remove override');
    } finally {
      setIsRemoving(false);
    }
  }

  return (
    <div className="mt-2 flex flex-col gap-3 rounded-lg border border-border bg-bg-overlay p-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {roleColor !== 0 && (
            <span
              className="inline-block h-3 w-3 rounded-full"
              style={{
                backgroundColor: roleColorHex(roleColor),
              }}
            />
          )}
          <span className="text-sm font-semibold text-text">{roleName}</span>
        </div>
        <div>
          {removeConfirm ? (
            <div className="flex items-center gap-1">
              <button
                type="button"
                disabled={isRemoving}
                onClick={handleRemove}
                className="rounded-md bg-error px-2 py-1 text-sm font-medium text-white hover:bg-error/80 disabled:opacity-50"
              >
                {isRemoving ? 'Removing...' : 'Confirm Remove'}
              </button>
              <button
                type="button"
                disabled={isRemoving}
                onClick={() => setRemoveConfirm(false)}
                className="rounded-md px-2 py-1 text-sm text-text-muted hover:text-text"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setRemoveConfirm(true)}
              className="rounded-md px-2 py-1 text-sm text-error hover:bg-error/10"
            >
              Remove Override
            </button>
          )}
        </div>
      </div>

      {/* Category sections */}
      <div className="flex flex-col gap-1">
        {categories.map((cat) => (
          <OverrideCategorySection
            key={cat}
            category={cat}
            getState={getState}
            setState={setState}
            callerHasPerm={callerHasPerm}
            disabled={isSaving}
          />
        ))}
      </div>

      {/* Error */}
      {error && <p className="text-xs text-error">{error}</p>}

      {/* External change warning */}
      {externalChange && (
        <div className="flex items-center justify-between rounded-md border border-warning/30 bg-warning/5 px-3 py-2">
          <span className="text-sm text-warning">
            Permissions were updated externally
          </span>
          <button
            type="button"
            onClick={acceptExternal}
            className="rounded-md bg-warning/10 px-3 py-1.5 text-sm text-warning hover:bg-warning/20"
          >
            Refresh
          </button>
        </div>
      )}

      {/* Unsaved changes bar */}
      {isDirty && (
        <div className="flex items-center justify-between rounded-md border border-border bg-bg-surface px-3 py-2">
          <span className="text-sm text-text-muted">
            You have unsaved changes
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={reset}
              disabled={isSaving}
              className="rounded-md bg-bg-surface px-3 py-1.5 text-sm text-text-muted hover:bg-bg-elevated hover:text-text disabled:opacity-50"
            >
              Reset
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={isSaving}
              className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-black hover:bg-accent/80 disabled:opacity-50"
            >
              {isSaving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * ChannelOverrideEditor — main exported component
 * --------------------------------------------------------------------------- */

const EMPTY_ROLES: never[] = [];
const EMPTY_OVERRIDES: never[] = [];

type OverrideTab = 'roles' | 'members';

export function ChannelOverrideEditor({
  serverId,
  channelId,
}: ChannelOverrideEditorProps) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const userId = useAuthStore((s) => s.user?.id);
  const reconnectCount = useGatewayStore((s) => s.reconnectCount);
  const server = useServerStore((s) => s.servers[serverId]);
  const roles = useRoleStore((s) => s.byServer[serverId] ?? EMPTY_ROLES);
  const members = useMemberStore((s) => s.byServer[serverId]);
  const overrides = usePermissionOverrideStore(
    (s) => s.byTarget[channelId] ?? EMPTY_OVERRIDES,
  );
  const overrideLoading = usePermissionOverrideStore(
    (s) => s.isLoading[channelId] ?? false,
  );

  // Find the channel to determine its type.
  const channels = useChannelStore((s) => s.byServer[serverId]);
  const channel = useMemo(
    () => channels?.find((c) => c.id === channelId),
    [channels, channelId],
  );

  const [callerPermissions, setCallerPermissions] = useState<bigint>(0n);
  const [expandedRoleId, setExpandedRoleId] = useState<string | null>(null);
  const [expandedUserId, setExpandedUserId] = useState<string | null>(null);
  const [addingRoleId, setAddingRoleId] = useState<string | null>(null);
  const [addingUser, setAddingUser] = useState(false);
  const [memberSearch, setMemberSearch] = useState('');
  const [activeTab, setActiveTab] = useState<OverrideTab>('roles');
  const [fetchError, setFetchError] = useState('');

  const isOwner = server?.ownerId === userId;

  // Caller's max role position for escalation prevention.
  const callerMaxPosition = useMemo(() => {
    if (isOwner) return Number.MAX_SAFE_INTEGER;
    if (!userId || !members) return -1;
    const me = members.find((m) => m.userId === userId);
    if (!me) return -1;
    let maxPos = -1;
    for (const role of roles) {
      if (me.roleIds.includes(role.id)) {
        maxPos = Math.max(maxPos, role.position);
      }
    }
    return maxPos;
  }, [isOwner, userId, members, roles]);

  // Determine which permission categories to show based on channel type.
  const categories = useMemo((): PermCategory[] => {
    if (!channel) return ['general', 'text'];
    if (channel.type === ChannelType.VOICE) {
      return CHANNEL_TYPE_CATEGORIES.voice;
    }
    return CHANNEL_TYPE_CATEGORIES.text;
  }, [channel]);

  // Fetch overrides, roles, and caller permissions on mount / reconnect.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reconnectCount is intentionally included to re-fetch after gateway reconnection
  useEffect(() => {
    if (!isAuthenticated || !serverId || !channelId) return;
    setFetchError('');

    const overrideStore = usePermissionOverrideStore.getState();
    overrideStore.setLoading(channelId, true);

    Promise.all([
      listPermissionOverrides(channelId).then((result) => {
        usePermissionOverrideStore.getState().setOverrides(channelId, result);
      }),
      listRoles(serverId),
      getEffectivePermissions(serverId).then((perms) =>
        setCallerPermissions(perms),
      ),
    ]).catch(() => {
      setFetchError('Failed to load permission data');
      usePermissionOverrideStore.getState().setLoading(channelId, false);
    });
  }, [serverId, channelId, isAuthenticated, reconnectCount]);

  /** Whether the caller has a given permission (for escalation prevention). */
  const callerHasPerm = useCallback(
    (perm: bigint): boolean => {
      if (isOwner) return true;
      return hasPermission(callerPermissions, perm);
    },
    [isOwner, callerPermissions],
  );

  // Split overrides into role and user overrides.
  const roleOverrides = useMemo(
    () => overrides.filter((o) => o.roleId !== ''),
    [overrides],
  );
  const userOverrides = useMemo(
    () => overrides.filter((o) => o.userId !== ''),
    [overrides],
  );

  // Build a set of role IDs that already have overrides.
  const overrideRoleIds = useMemo(
    () => new Set(roleOverrides.map((o) => o.roleId)),
    [roleOverrides],
  );

  // Build a set of user IDs that already have overrides.
  const overrideUserIds = useMemo(
    () => new Set(userOverrides.map((o) => o.userId)),
    [userOverrides],
  );

  // Roles available to add (no existing override, position below caller).
  const availableRoles = useMemo(
    () =>
      roles.filter(
        (r) =>
          !overrideRoleIds.has(r.id) &&
          (isOwner || r.position < callerMaxPosition),
      ),
    [roles, overrideRoleIds, isOwner, callerMaxPosition],
  );

  // Helper: get a member's max role position.
  const getMemberMaxPos = useCallback(
    (memberUserId: string): number => {
      if (!members) return 0;
      const m = members.find((mem) => mem.userId === memberUserId);
      if (!m) return 0;
      let maxPos = 0;
      for (const role of roles) {
        if (m.roleIds.includes(role.id) && role.position > maxPos) {
          maxPos = role.position;
        }
      }
      return maxPos;
    },
    [members, roles],
  );

  // Members available to add user overrides (no existing override, not server owner, below caller position).
  const availableMembers = useMemo(() => {
    if (!members) return [];
    const search = memberSearch.toLowerCase().trim();
    return members.filter((m) => {
      if (overrideUserIds.has(m.userId)) return false;
      if (m.userId === server?.ownerId) return false;
      if (m.userId === userId) return false;
      if (!isOwner && getMemberMaxPos(m.userId) >= callerMaxPosition)
        return false;
      if (search) {
        const name = (m.nickname || m.userId).toLowerCase();
        return name.includes(search);
      }
      return true;
    });
  }, [
    members,
    overrideUserIds,
    server?.ownerId,
    userId,
    isOwner,
    callerMaxPosition,
    memberSearch,
    getMemberMaxPos,
  ]);

  // Roles that have overrides (in display order).
  const overrideRoles = useMemo(() => {
    const map = new Map(roles.map((r) => [r.id, r]));
    return roleOverrides
      .map((o) => {
        const role = map.get(o.roleId);
        return role ? { role, override: o } : null;
      })
      .filter(
        (
          item,
        ): item is {
          role: (typeof roles)[number];
          override: (typeof roleOverrides)[number];
        } => item !== null,
      );
  }, [roleOverrides, roles]);

  // Users that have overrides (in display order).
  const overrideUsers = useMemo(() => {
    if (!members) return [];
    const memberMap = new Map(members.map((m) => [m.userId, m]));
    return userOverrides
      .map((o) => {
        const member = memberMap.get(o.userId);
        return member ? { member, override: o } : null;
      })
      .filter(
        (
          item,
        ): item is {
          member: (typeof members)[number];
          override: (typeof userOverrides)[number];
        } => item !== null,
      );
  }, [userOverrides, members]);

  async function handleAddOverride(roleId: string) {
    setAddingRoleId(null);
    try {
      const override = await setPermissionOverride(channelId, roleId, 0n, 0n);
      if (override) {
        usePermissionOverrideStore
          .getState()
          .upsertOverride(channelId, override);
      }
      setExpandedRoleId(roleId);
    } catch {
      setFetchError('Failed to add override');
    }
  }

  async function handleAddUserOverride(targetUserId: string) {
    setAddingUser(false);
    setMemberSearch('');
    try {
      const override = await setPermissionOverride(
        channelId,
        '',
        0n,
        0n,
        targetUserId,
      );
      if (override) {
        usePermissionOverrideStore
          .getState()
          .upsertOverride(channelId, override);
      }
      setExpandedUserId(targetUserId);
    } catch {
      setFetchError('Failed to add user override');
    }
  }

  function refreshOverrides() {
    listPermissionOverrides(channelId)
      .then((result) => {
        usePermissionOverrideStore.getState().setOverrides(channelId, result);
      })
      .catch(() => {});
  }

  if (overrideLoading) {
    return <div className="text-sm text-text-muted">Loading overrides...</div>;
  }

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-text">
            Channel Permission Overrides
          </h2>
          <p className="text-xs text-text-muted">
            Override permissions for this specific channel. Overrides take
            precedence over server-level permissions.
          </p>
        </div>
      </div>

      {/* Segmented control: Roles | Members */}
      <div className="mb-4 flex gap-0.5 rounded-md bg-bg-surface p-0.5">
        {(['roles', 'members'] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => setActiveTab(tab)}
            className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
              activeTab === tab
                ? 'bg-bg-elevated text-text'
                : 'text-text-muted hover:text-text'
            }`}
          >
            {tab === 'roles' ? 'Roles' : 'Members'}
            {tab === 'roles' && roleOverrides.length > 0 && (
              <span className="ml-1.5 text-xs text-text-subtle">
                {roleOverrides.length}
              </span>
            )}
            {tab === 'members' && userOverrides.length > 0 && (
              <span className="ml-1.5 text-xs text-text-subtle">
                {userOverrides.length}
              </span>
            )}
          </button>
        ))}
      </div>

      {fetchError && (
        <div className="mb-3 rounded-md border border-error/30 bg-error/5 px-3 py-2 text-sm text-error">
          {fetchError}
        </div>
      )}

      {/* Roles tab */}
      {activeTab === 'roles' && (
        <>
          {/* Add role override dropdown */}
          <div className="mb-4">
            {addingRoleId !== null ? (
              <div className="flex items-center gap-2">
                <select
                  className="rounded-md border border-border bg-bg-surface px-3 py-1.5 text-sm text-text focus:border-accent focus:outline-none"
                  value=""
                  onChange={(e) => {
                    if (e.target.value) handleAddOverride(e.target.value);
                  }}
                >
                  <option value="" disabled>
                    Select a role...
                  </option>
                  {availableRoles.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.id === serverId ? '@everyone' : r.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => setAddingRoleId(null)}
                  className="rounded-md px-2 py-1.5 text-sm text-text-muted hover:text-text"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setAddingRoleId('')}
                disabled={availableRoles.length === 0}
                className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-black hover:bg-accent/80 disabled:opacity-50"
              >
                Add Role Override
              </button>
            )}
          </div>

          {overrideRoles.length === 0 && !fetchError && (
            <p className="text-sm text-text-muted">
              No role permission overrides configured for this channel.
            </p>
          )}

          <div className="flex flex-col gap-2">
            {overrideRoles.map(({ role, override }) => {
              const isEveryone = role.id === serverId;
              const isExpanded = expandedRoleId === role.id;

              return (
                <div
                  key={role.id}
                  className="rounded-lg border border-border bg-bg-surface"
                >
                  <button
                    type="button"
                    onClick={() =>
                      setExpandedRoleId(isExpanded ? null : role.id)
                    }
                    className="flex w-full items-center gap-2 px-3 py-2.5 text-left"
                  >
                    <CaretRightIcon
                      size={16}
                      className={`shrink-0 text-text-muted transition-transform ${isExpanded ? 'rotate-90' : ''}`}
                      aria-hidden="true"
                    />
                    {role.color !== 0 && (
                      <span
                        className="inline-block h-3 w-3 rounded-full"
                        style={{
                          backgroundColor: roleColorHex(role.color),
                        }}
                      />
                    )}
                    <span className="text-sm font-medium text-text">
                      {isEveryone ? '@everyone' : role.name}
                    </span>
                    {isEveryone && (
                      <span className="rounded bg-bg-elevated px-1.5 py-0.5 text-xs text-text-muted">
                        default
                      </span>
                    )}
                  </button>

                  {isExpanded && (
                    <div className="px-3 pb-3">
                      <RoleOverridePanel
                        channelId={channelId}
                        roleId={role.id}
                        roleName={isEveryone ? '@everyone' : role.name}
                        roleColor={role.color}
                        initialAllow={override.allow}
                        initialDeny={override.deny}
                        categories={categories}
                        callerHasPerm={callerHasPerm}
                        onRemove={() => setExpandedRoleId(null)}
                        onSaved={refreshOverrides}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* Members tab */}
      {activeTab === 'members' && (
        <>
          {/* Add user override */}
          <div className="mb-4">
            {addingUser ? (
              <div className="space-y-2">
                <input
                  type="text"
                  value={memberSearch}
                  onChange={(e) => setMemberSearch(e.target.value)}
                  placeholder="Search members..."
                  className="w-full rounded-md border border-border bg-bg-surface px-3 py-1.5 text-sm text-text placeholder:text-text-subtle focus:border-accent focus:outline-none"
                />
                {availableMembers.length > 0 && (
                  <div className="max-h-48 overflow-y-auto rounded-md border border-border bg-bg-surface">
                    {availableMembers.slice(0, 20).map((m) => (
                      <button
                        key={m.userId}
                        type="button"
                        onClick={() => handleAddUserOverride(m.userId)}
                        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-bg-elevated"
                      >
                        <span className="h-5 w-5 shrink-0 rounded-full bg-bg-elevated" />
                        <span className="text-text">
                          {m.nickname || m.userId.slice(0, 8)}
                        </span>
                      </button>
                    ))}
                    {availableMembers.length > 20 && (
                      <p className="px-3 py-1.5 text-xs text-text-subtle">
                        {availableMembers.length - 20} more — refine your search
                      </p>
                    )}
                  </div>
                )}
                {memberSearch.trim() && availableMembers.length === 0 && (
                  <p className="text-xs text-text-subtle">
                    No matching members found
                  </p>
                )}
                <button
                  type="button"
                  onClick={() => {
                    setAddingUser(false);
                    setMemberSearch('');
                  }}
                  className="rounded-md px-2 py-1.5 text-sm text-text-muted hover:text-text"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setAddingUser(true)}
                className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-black hover:bg-accent/80"
              >
                Add Member Override
              </button>
            )}
          </div>

          {overrideUsers.length === 0 && !fetchError && (
            <p className="text-sm text-text-muted">
              No member permission overrides configured for this channel.
            </p>
          )}

          <div className="flex flex-col gap-2">
            {overrideUsers.map(({ member, override }) => {
              const isExpanded = expandedUserId === member.userId;
              const targetMaxPos = getMemberMaxPos(member.userId);
              const canEdit = isOwner || callerMaxPosition > targetMaxPos;

              return (
                <div
                  key={member.userId}
                  className="rounded-lg border border-border bg-bg-surface"
                >
                  <button
                    type="button"
                    onClick={() =>
                      setExpandedUserId(isExpanded ? null : member.userId)
                    }
                    className="flex w-full items-center gap-2 px-3 py-2.5 text-left"
                  >
                    <CaretRightIcon
                      size={16}
                      className={`shrink-0 text-text-muted transition-transform ${isExpanded ? 'rotate-90' : ''}`}
                      aria-hidden="true"
                    />
                    <span className="h-5 w-5 shrink-0 rounded-full bg-bg-elevated" />
                    <span className="text-sm font-medium text-text">
                      {member.nickname || member.userId.slice(0, 8)}
                    </span>
                    {!canEdit && (
                      <span className="rounded bg-bg-elevated px-1.5 py-0.5 text-xs text-text-muted">
                        higher role
                      </span>
                    )}
                  </button>

                  {isExpanded && (
                    <div className="px-3 pb-3">
                      <UserOverridePanel
                        channelId={channelId}
                        targetUserId={member.userId}
                        displayName={
                          member.nickname || member.userId.slice(0, 8)
                        }
                        initialAllow={override.allow}
                        initialDeny={override.deny}
                        categories={categories}
                        callerHasPerm={callerHasPerm}
                        disabled={!canEdit}
                        onRemove={() => setExpandedUserId(null)}
                        onSaved={refreshOverrides}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * UserOverridePanel — editor for a single user's overrides
 * --------------------------------------------------------------------------- */

function UserOverridePanel({
  channelId,
  targetUserId,
  displayName,
  initialAllow,
  initialDeny,
  categories,
  callerHasPerm,
  disabled,
  onRemove,
  onSaved,
}: {
  channelId: string;
  targetUserId: string;
  displayName: string;
  initialAllow: bigint;
  initialDeny: bigint;
  categories: PermCategory[];
  callerHasPerm: (perm: bigint) => boolean;
  disabled: boolean;
  onRemove: () => void;
  onSaved: () => void;
}) {
  const {
    allow,
    deny,
    getState,
    setState,
    isDirty,
    reset,
    externalChange,
    acceptExternal,
  } = usePermissionEditor(initialAllow, initialDeny);
  const [isSaving, setIsSaving] = useState(false);
  const [isRemoving, setIsRemoving] = useState(false);
  const [removeConfirm, setRemoveConfirm] = useState(false);
  const [error, setError] = useState('');

  async function handleSave() {
    setIsSaving(true);
    setError('');
    try {
      const override = await setPermissionOverride(
        channelId,
        '',
        allow,
        deny,
        targetUserId,
      );
      if (override) {
        usePermissionOverrideStore
          .getState()
          .upsertOverride(channelId, override);
      }
      onSaved();
    } catch {
      setError('Failed to save override');
    } finally {
      setIsSaving(false);
    }
  }

  async function handleRemove() {
    setIsRemoving(true);
    setError('');
    try {
      await deletePermissionOverride(channelId, '', targetUserId);
      usePermissionOverrideStore
        .getState()
        .removeOverride(channelId, '', targetUserId);
      onRemove();
    } catch {
      setError('Failed to remove override');
    } finally {
      setIsRemoving(false);
    }
  }

  return (
    <div className="mt-2 flex flex-col gap-3 rounded-lg border border-border bg-bg-overlay p-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-text">{displayName}</span>
        <div>
          {removeConfirm ? (
            <div className="flex items-center gap-1">
              <button
                type="button"
                disabled={isRemoving}
                onClick={handleRemove}
                className="rounded-md bg-error px-2 py-1 text-sm font-medium text-white hover:bg-error/80 disabled:opacity-50"
              >
                {isRemoving ? 'Removing...' : 'Confirm Remove'}
              </button>
              <button
                type="button"
                disabled={isRemoving}
                onClick={() => setRemoveConfirm(false)}
                className="rounded-md px-2 py-1 text-sm text-text-muted hover:text-text"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setRemoveConfirm(true)}
              disabled={disabled}
              className="rounded-md px-2 py-1 text-sm text-error hover:bg-error/10 disabled:opacity-50"
            >
              Remove Override
            </button>
          )}
        </div>
      </div>

      {/* Category sections */}
      <div className="flex flex-col gap-1">
        {categories.map((cat) => (
          <OverrideCategorySection
            key={cat}
            category={cat}
            getState={getState}
            setState={setState}
            callerHasPerm={callerHasPerm}
            disabled={isSaving || disabled}
          />
        ))}
      </div>

      {error && <p className="text-xs text-error">{error}</p>}

      {externalChange && (
        <div className="flex items-center justify-between rounded-md border border-warning/30 bg-warning/5 px-3 py-2">
          <span className="text-sm text-warning">
            Permissions were updated externally
          </span>
          <button
            type="button"
            onClick={acceptExternal}
            className="rounded-md bg-warning/10 px-3 py-1.5 text-sm text-warning hover:bg-warning/20"
          >
            Refresh
          </button>
        </div>
      )}

      {isDirty && !disabled && (
        <div className="flex items-center justify-between rounded-md border border-border bg-bg-surface px-3 py-2">
          <span className="text-sm text-text-muted">
            You have unsaved changes
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={reset}
              disabled={isSaving}
              className="rounded-md bg-bg-surface px-3 py-1.5 text-sm text-text-muted hover:bg-bg-elevated hover:text-text disabled:opacity-50"
            >
              Reset
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={isSaving}
              className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-black hover:bg-accent/80 disabled:opacity-50"
            >
              {isSaving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
