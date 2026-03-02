import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  CATEGORY_META,
  createRole,
  deleteRole,
  getEffectivePermissions,
  hasPermission,
  listRoles,
  PERMISSION_INFO,
  PERMISSIONS_BY_CATEGORY,
  type PermCategory,
  Permissions,
  updateRole,
  useAuthStore,
  useMemberStore,
  useRoleStore,
  useServerStore,
} from '@meza/core';
import { CaretRightIcon, CheckIcon, MinusIcon } from '@phosphor-icons/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { roleColorHex } from '../../utils/color.ts';

const EMPTY_ROLES: never[] = [];

/** Order in which categories render. */
const CATEGORY_ORDER: PermCategory[] = [
  'general',
  'text',
  'voice',
  'moderation',
  'server',
];

/** Count the number of set permission bits (excluding ADMINISTRATOR granting all). */
function countPermissions(perms: bigint): number {
  let count = 0;
  for (const key of Object.keys(PERMISSION_INFO)) {
    const bit = Permissions[key as keyof typeof Permissions];
    if (bit !== undefined && (perms & bit) !== 0n) count++;
  }
  return count;
}

interface RolesSectionProps {
  serverId: string;
}

export function RolesSection({ serverId }: RolesSectionProps) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const userId = useAuthStore((s) => s.user?.id);
  const roles = useRoleStore((s) => s.byServer[serverId] ?? EMPTY_ROLES);
  const server = useServerStore((s) => s.servers[serverId]);
  const members = useMemberStore((s) => s.byServer[serverId]);
  const [showCreate, setShowCreate] = useState(false);
  const [expandedRoleId, setExpandedRoleId] = useState<string | null>(null);
  const [callerPermissions, setCallerPermissions] = useState<bigint>(0n);

  // Drag snapshot: freeze role list during active drag to prevent gateway events
  // from corrupting dnd-kit state.
  const isDraggingRef = useRef(false);
  const dragSnapshotRef = useRef(roles);
  if (!isDraggingRef.current) {
    dragSnapshotRef.current = roles;
  }
  const displayRoles = isDraggingRef.current ? dragSnapshotRef.current : roles;

  const isOwner = server?.ownerId === userId;

  // Compute caller's max position from their own roles.
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

  // Split roles: draggable (non-@everyone, below caller) vs non-draggable.
  // Roles are sorted by position DESC from the store, so highest position first.
  const { draggableRoles, everyoneRole, aboveCallerRoles } = useMemo(() => {
    const draggable: typeof roles = [];
    const aboveCaller: typeof roles = [];
    let everyone: (typeof roles)[0] | null = null;

    for (const role of displayRoles) {
      if (role.id === serverId) {
        everyone = role;
      } else if (isOwner || role.position < callerMaxPosition) {
        draggable.push(role);
      } else {
        aboveCaller.push(role);
      }
    }

    return {
      draggableRoles: draggable,
      everyoneRole: everyone,
      aboveCallerRoles: aboveCaller,
    };
  }, [displayRoles, serverId, isOwner, callerMaxPosition]);

  const draggableIds = useMemo(
    () => draggableRoles.map((r) => r.id),
    [draggableRoles],
  );

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor),
  );

  useEffect(() => {
    if (!isAuthenticated || !serverId) return;
    listRoles(serverId).catch(() => {});
  }, [serverId, isAuthenticated]);

  // Fetch caller's effective permissions for escalation prevention.
  useEffect(() => {
    if (!isAuthenticated || !serverId) return;
    getEffectivePermissions(serverId)
      .then((perms) => setCallerPermissions(perms))
      .catch(() => {});
  }, [serverId, isAuthenticated]);

  async function handleDeleteRole(roleId: string) {
    await deleteRole(roleId);
    useRoleStore.getState().removeRole(serverId, roleId);
    setExpandedRoleId(null);
  }

  function handleDragStart() {
    isDraggingRef.current = true;
    dragSnapshotRef.current = roles;
  }

  function handleDragEnd(event: DragEndEvent) {
    isDraggingRef.current = false;

    const { active, over } = event;
    if (!over || active.id === over.id) return;

    // Compute new ordering from the drag result.
    const oldIndex = draggableIds.indexOf(active.id as string);
    const newIndex = draggableIds.indexOf(over.id as string);
    if (oldIndex === -1 || newIndex === -1) return;

    // Build new ordered list: roles are displayed highest-first (position DESC),
    // but the API expects lowest-first (index 0 = position 1).
    const reordered = [...draggableIds];
    reordered.splice(oldIndex, 1);
    reordered.splice(newIndex, 0, active.id as string);

    // API expects: index 0 = lowest position. Our display is position DESC,
    // so reverse to get lowest-first.
    const roleIdsForApi = [...reordered].reverse();

    useRoleStore.getState().reorderRoles(serverId, roleIdsForApi);
  }

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-text">Roles</h2>
        <button
          type="button"
          onClick={() => setShowCreate(true)}
          className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-black hover:bg-accent/80"
        >
          Create Role
        </button>
      </div>

      {showCreate && (
        <div className="mb-3 rounded-lg border border-border bg-bg-surface p-3">
          <RoleForm
            serverId={serverId}
            callerPermissions={callerPermissions}
            isOwner={isOwner}
            onCancel={() => setShowCreate(false)}
            onDone={() => setShowCreate(false)}
          />
        </div>
      )}

      {roles.length === 0 && !showCreate && (
        <p className="text-sm text-text-muted">No roles configured.</p>
      )}

      <div className="flex flex-col gap-1.5">
        {/* Non-draggable: roles above caller's position */}
        {aboveCallerRoles.map((role) => (
          <RoleItem
            key={role.id}
            role={role}
            serverId={serverId}
            isEveryone={false}
            canEdit={false}
            isExpanded={expandedRoleId === role.id}
            onToggle={() => {}}
            callerPermissions={callerPermissions}
            isOwner={isOwner}
          />
        ))}

        {/* Draggable roles below caller */}
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={draggableIds}
            strategy={verticalListSortingStrategy}
          >
            {draggableRoles.map((role) => (
              <SortableRoleItem
                key={role.id}
                role={role}
                serverId={serverId}
                isExpanded={expandedRoleId === role.id}
                onToggle={() =>
                  setExpandedRoleId(expandedRoleId === role.id ? null : role.id)
                }
                callerPermissions={callerPermissions}
                isOwner={isOwner}
                onDelete={handleDeleteRole}
              />
            ))}
          </SortableContext>
        </DndContext>

        {/* @everyone always at the bottom */}
        {everyoneRole && (
          <RoleItem
            role={everyoneRole}
            serverId={serverId}
            isEveryone={true}
            canEdit={true}
            isExpanded={expandedRoleId === everyoneRole.id}
            onToggle={() =>
              setExpandedRoleId(
                expandedRoleId === everyoneRole.id ? null : everyoneRole.id,
              )
            }
            callerPermissions={callerPermissions}
            isOwner={isOwner}
          />
        )}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Role Item (non-sortable, accordion style)
 * --------------------------------------------------------------------------- */

interface RoleItemProps {
  role: {
    id: string;
    name: string;
    color: number;
    permissions: bigint;
    position: number;
    isSelfAssignable: boolean;
  };
  serverId: string;
  isEveryone: boolean;
  canEdit: boolean;
  isExpanded: boolean;
  onToggle: () => void;
  callerPermissions: bigint;
  isOwner: boolean;
  onDelete?: (id: string) => Promise<void>;
}

function RoleItem({
  role,
  serverId,
  isEveryone,
  canEdit,
  isExpanded,
  onToggle,
  callerPermissions,
  isOwner,
  onDelete,
}: RoleItemProps) {
  const permCount = countPermissions(role.permissions);

  return (
    <div>
      <button
        type="button"
        onClick={canEdit ? onToggle : undefined}
        className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-left hover:bg-bg-elevated/50 ${
          canEdit ? 'cursor-pointer' : 'cursor-default'
        }`}
      >
        {canEdit && (
          <CaretRightIcon
            size={16}
            className={`shrink-0 text-text-muted transition-transform ${isExpanded ? 'rotate-90' : ''}`}
            aria-hidden="true"
          />
        )}
        <span
          className="text-sm font-medium"
          style={{ color: roleColorHex(role.color) }}
        >
          {isEveryone ? '@everyone' : role.name}
        </span>
        {isEveryone && (
          <span className="rounded bg-bg-elevated px-1.5 py-0.5 text-xs text-text-muted">
            default
          </span>
        )}
        <span className="rounded bg-accent-subtle px-1.5 py-0.5 text-xs text-accent">
          {permCount} {permCount === 1 ? 'permission' : 'permissions'}
        </span>
        {!canEdit && (
          <span className="ml-auto rounded bg-bg-elevated px-1.5 py-0.5 text-xs text-text-muted">
            higher role
          </span>
        )}
      </button>

      {isExpanded && canEdit && (
        <div className="px-3 pb-3">
          <RoleForm
            serverId={serverId}
            roleId={role.id}
            initialName={role.name}
            initialColor={role.color}
            initialPermissions={role.permissions}
            initialIsSelfAssignable={role.isSelfAssignable}
            isEveryone={isEveryone}
            callerPermissions={callerPermissions}
            isOwner={isOwner}
            onCancel={onToggle}
            onDone={onToggle}
            onDelete={!isEveryone ? onDelete : undefined}
          />
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Sortable Role Item (draggable, accordion style)
 * --------------------------------------------------------------------------- */

function SortableRoleItem({
  role,
  serverId,
  isExpanded,
  onToggle,
  callerPermissions,
  isOwner,
  onDelete,
}: {
  role: RoleItemProps['role'];
  serverId: string;
  isExpanded: boolean;
  onToggle: () => void;
  callerPermissions: bigint;
  isOwner: boolean;
  onDelete: (id: string) => Promise<void>;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: role.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const permCount = countPermissions(role.permissions);

  return (
    <div ref={setNodeRef} style={style}>
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full cursor-grab items-center gap-2 rounded-md px-3 py-2 text-left hover:bg-bg-elevated/50 active:cursor-grabbing"
        {...attributes}
        {...listeners}
      >
        <CaretRightIcon
          size={16}
          className={`shrink-0 text-text-muted transition-transform ${isExpanded ? 'rotate-90' : ''}`}
          aria-hidden="true"
        />
        <span
          className="text-sm font-medium"
          style={{ color: roleColorHex(role.color) }}
        >
          {role.name}
        </span>
        <span className="rounded bg-accent-subtle px-1.5 py-0.5 text-xs text-accent">
          {permCount} {permCount === 1 ? 'permission' : 'permissions'}
        </span>
      </button>

      {isExpanded && (
        <div className="px-3 pb-3">
          <RoleForm
            serverId={serverId}
            roleId={role.id}
            initialName={role.name}
            initialColor={role.color}
            initialPermissions={role.permissions}
            initialIsSelfAssignable={role.isSelfAssignable}
            callerPermissions={callerPermissions}
            isOwner={isOwner}
            onCancel={onToggle}
            onDone={onToggle}
            onDelete={onDelete}
          />
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * PermissionToggle — grant / not granted (button-group style like overrides)
 * --------------------------------------------------------------------------- */

function PermissionToggle({
  granted,
  onChange,
  disabled,
  label,
}: {
  granted: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  function handleKeyDown(e: React.KeyboardEvent) {
    if (disabled) return;
    if (
      e.key === 'ArrowRight' ||
      e.key === 'ArrowDown' ||
      e.key === 'ArrowLeft' ||
      e.key === 'ArrowUp'
    ) {
      e.preventDefault();
      onChange(!granted);
    }
  }

  return (
    <div
      role="radiogroup"
      aria-label={`${label} permission`}
      className="flex items-center gap-0.5"
      onKeyDown={handleKeyDown}
    >
      {/* biome-ignore lint/a11y/useSemanticElements: toggle uses custom radio buttons for visual consistency with channel overrides */}
      <button
        type="button"
        role="radio"
        aria-checked={!granted}
        aria-label="Not granted"
        disabled={disabled}
        onClick={() => onChange(false)}
        className={`flex h-7 w-7 items-center justify-center rounded-l-md text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
          !granted
            ? 'bg-bg-elevated text-text'
            : 'bg-bg-elevated text-text-subtle hover:text-text'
        }`}
        tabIndex={!granted ? 0 : -1}
      >
        <MinusIcon size={14} aria-hidden="true" />
      </button>

      {/* biome-ignore lint/a11y/useSemanticElements: toggle uses custom radio buttons for visual consistency with channel overrides */}
      <button
        type="button"
        role="radio"
        aria-checked={granted}
        aria-label="Granted"
        disabled={disabled}
        onClick={() => onChange(true)}
        className={`flex h-7 w-7 items-center justify-center rounded-r-md text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
          granted
            ? 'bg-success/20 text-success'
            : 'bg-bg-elevated text-text-subtle hover:text-text'
        }`}
        tabIndex={granted ? 0 : -1}
      >
        <CheckIcon size={14} aria-hidden="true" />
      </button>
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Role Form
 * --------------------------------------------------------------------------- */

interface RoleFormProps {
  serverId: string;
  roleId?: string;
  initialName?: string;
  initialColor?: number;
  initialPermissions?: bigint;
  initialIsSelfAssignable?: boolean;
  isEveryone?: boolean;
  callerPermissions: bigint;
  isOwner: boolean;
  onCancel: () => void;
  onDone: () => void;
  onDelete?: (roleId: string) => Promise<void>;
}

function RoleForm({
  serverId,
  roleId,
  initialName = '',
  initialColor = 0,
  initialPermissions = 0n,
  initialIsSelfAssignable = false,
  isEveryone = false,
  callerPermissions,
  isOwner,
  onCancel,
  onDone,
  onDelete,
}: RoleFormProps) {
  const [name, setName] = useState(initialName);
  const [colorHex, setColorHex] = useState(
    roleColorHex(initialColor) ?? '#000000',
  );
  const [permissions, setPermissions] = useState(initialPermissions);
  const [isSelfAssignable, setIsSelfAssignable] = useState(
    initialIsSelfAssignable,
  );
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [pendingAdminGrant, setPendingAdminGrant] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  function togglePermission(perm: bigint, granted: boolean) {
    // If granting ADMINISTRATOR, show confirmation instead.
    if (
      granted &&
      perm === Permissions.ADMINISTRATOR &&
      (permissions & Permissions.ADMINISTRATOR) === 0n
    ) {
      setPendingAdminGrant(true);
      return;
    }
    setPermissions((prev) => (granted ? prev | perm : prev & ~perm));
  }

  function confirmAdminGrant() {
    setPermissions((prev) => prev | Permissions.ADMINISTRATOR);
    setPendingAdminGrant(false);
  }

  function cancelAdminGrant() {
    setPendingAdminGrant(false);
  }

  /** Whether the caller has a given permission (for escalation prevention). */
  function callerHasPerm(perm: bigint): boolean {
    if (isOwner) return true;
    return hasPermission(callerPermissions, perm);
  }

  async function handleSubmit() {
    const trimmed = isEveryone ? initialName || '@everyone' : name.trim();
    if (!isEveryone && !trimmed) return;

    setSubmitError('');
    setIsSubmitting(true);

    const color = parseInt(colorHex.slice(1), 16) || 0;

    try {
      if (roleId) {
        await updateRole(roleId, {
          name: isEveryone ? undefined : trimmed,
          permissions,
          color,
          isSelfAssignable: isEveryone ? undefined : isSelfAssignable,
        });
      } else {
        await createRole(serverId, trimmed, permissions, color);
      }
      onDone();
    } catch {
      setSubmitError(
        roleId ? 'Failed to update role' : 'Failed to create role',
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleDelete() {
    if (!roleId || !onDelete) return;
    setIsDeleting(true);
    try {
      await onDelete(roleId);
    } catch {
      setSubmitError('Failed to delete role');
    } finally {
      setIsDeleting(false);
      setDeleteConfirm(false);
    }
  }

  const hasAdmin = (permissions & Permissions.ADMINISTRATOR) !== 0n;

  return (
    <div className="flex flex-col gap-4">
      {/* @everyone header */}
      {isEveryone && (
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-text">@everyone</span>
          <span className="rounded bg-bg-elevated px-1.5 py-0.5 text-xs text-text-muted">
            default
          </span>
          <span className="text-xs text-text-subtle">
            Base permissions for all server members
          </span>
        </div>
      )}

      {/* Name + Color row (hidden for @everyone) */}
      {!isEveryone && (
        <div className="flex gap-3">
          <div className="flex-1">
            {/* biome-ignore lint/a11y/noLabelWithoutControl: label wraps its input */}
            <label className="block text-sm font-medium text-text-muted">
              Name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={isSubmitting}
              placeholder="Role name"
              className="mt-1 w-full rounded-md border border-border bg-bg-surface px-3 py-1.5 text-sm text-text placeholder:text-text-subtle focus:border-accent focus:outline-none disabled:opacity-50"
            />
          </div>
          <div>
            {/* biome-ignore lint/a11y/noLabelWithoutControl: label is adjacent to its input */}
            <label className="block text-sm font-medium text-text-muted">
              Color
            </label>
            <input
              type="color"
              value={colorHex}
              onChange={(e) => setColorHex(e.target.value)}
              disabled={isSubmitting}
              className="mt-1 h-[34px] w-12 cursor-pointer rounded-md border border-border bg-bg-surface"
            />
          </div>
        </div>
      )}

      {/* Self-assignable checkbox (hidden for @everyone) */}
      {!isEveryone && (
        <label className="flex items-center gap-2 text-sm text-text">
          <input
            type="checkbox"
            checked={isSelfAssignable}
            onChange={() => setIsSelfAssignable((v) => !v)}
            disabled={isSubmitting}
            className="rounded border-border"
          />
          Allow members to self-assign this role
        </label>
      )}

      {/* Administrator warning banner */}
      {hasAdmin && (
        <div className="rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-sm text-warning">
          This role has Administrator privileges. Members with this role bypass
          all permission checks and channel overrides.
        </div>
      )}

      {/* Pending admin grant confirmation */}
      {pendingAdminGrant && (
        <div className="rounded-md border border-warning/30 bg-warning/5 px-3 py-2">
          <p className="text-sm font-medium text-warning">
            Grant Administrator access?
          </p>
          <p className="mt-1 text-xs text-text-muted">
            Members with this role will have full access to every permission and
            bypass all channel overrides. This cannot be undone easily.
          </p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={confirmAdminGrant}
              className="rounded-md bg-warning px-3 py-1 text-sm font-medium text-black hover:bg-warning/80"
            >
              Grant Administrator
            </button>
            <button
              type="button"
              onClick={cancelAdminGrant}
              className="rounded-md bg-bg-surface px-3 py-1 text-sm text-text-muted hover:bg-bg-elevated hover:text-text"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Permission categories */}
      <div>
        <span className="block text-sm font-medium text-text-muted">
          Permissions
        </span>
        <div className="mt-2 flex flex-col gap-1">
          {CATEGORY_ORDER.map((cat) => (
            <PermissionCategory
              key={cat}
              category={cat}
              permissions={permissions}
              onToggle={togglePermission}
              callerHasPerm={callerHasPerm}
              disabled={isSubmitting}
            />
          ))}
        </div>
      </div>

      {submitError && <p className="text-xs text-error">{submitError}</p>}

      {/* Action buttons */}
      <div className="flex items-center justify-between">
        {/* Delete (left side, only for existing non-@everyone roles) */}
        <div>
          {roleId &&
            onDelete &&
            !isEveryone &&
            (deleteConfirm ? (
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  disabled={isDeleting}
                  onClick={handleDelete}
                  className="rounded-md bg-error px-2 py-1 text-sm font-medium text-white hover:bg-error/80 disabled:opacity-50"
                >
                  {isDeleting ? 'Deleting...' : 'Confirm Delete'}
                </button>
                <button
                  type="button"
                  disabled={isDeleting}
                  onClick={() => setDeleteConfirm(false)}
                  className="rounded-md px-2 py-1 text-sm text-text-muted hover:text-text"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setDeleteConfirm(true)}
                className="rounded-md px-2 py-1 text-sm text-error hover:bg-error/10"
              >
                Delete Role
              </button>
            ))}
        </div>

        {/* Save / Cancel (right side) */}
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={isSubmitting}
            className="rounded-md bg-bg-surface px-3 py-1.5 text-sm text-text-muted hover:bg-bg-elevated hover:text-text disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={isSubmitting || (!isEveryone && !name.trim())}
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-black hover:bg-accent/80 disabled:opacity-50"
          >
            {isSubmitting
              ? roleId
                ? 'Saving...'
                : 'Creating...'
              : roleId
                ? 'Save'
                : 'Create'}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Permission Category (collapsible <details>, borderless)
 * --------------------------------------------------------------------------- */

function PermissionCategory({
  category,
  permissions,
  onToggle,
  callerHasPerm,
  disabled,
}: {
  category: PermCategory;
  permissions: bigint;
  onToggle: (perm: bigint, granted: boolean) => void;
  callerHasPerm: (perm: bigint) => boolean;
  disabled: boolean;
}) {
  const meta = CATEGORY_META[category];
  const permKeys = PERMISSIONS_BY_CATEGORY[category];

  return (
    <details className="group">
      <summary className="flex cursor-pointer select-none items-center gap-2 py-2 text-sm font-medium text-text">
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
      <div className="flex flex-col gap-0.5 pb-1 pl-6">
        {permKeys.map((key) => {
          const info = PERMISSION_INFO[key];
          const bit = Permissions[key as keyof typeof Permissions];
          if (!info || bit === undefined) return null;
          const isGranted = (permissions & bit) !== 0n;
          const canToggle = callerHasPerm(bit);

          return (
            <div
              key={key}
              className={`flex items-center justify-between rounded-md px-2 py-2 ${
                canToggle ? '' : 'opacity-40 pointer-events-none'
              }`}
              title={canToggle ? undefined : 'You do not have this permission'}
            >
              <div className="flex-1 pr-4">
                <div className="text-sm font-medium text-text">{info.name}</div>
                <div className="text-xs text-text-muted">
                  {info.description}
                </div>
              </div>
              <PermissionToggle
                granted={isGranted}
                onChange={(next) => onToggle(bit, next)}
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
