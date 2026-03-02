import type { Role } from '@meza/core';
import { roleColorHex } from '../../utils/color.ts';

interface RolesStepProps {
  roles: Role[];
  selectedIds: Set<string>;
  onSelectionChange: (ids: Set<string>) => void;
  readOnly: boolean;
}

export function RolesStep({
  roles,
  selectedIds,
  onSelectionChange,
  readOnly,
}: RolesStepProps) {
  const toggleRole = (id: string) => {
    if (readOnly) return;
    const next = new Set(selectedIds);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    onSelectionChange(next);
  };

  return (
    <div className="flex flex-col">
      <h2 className="mb-1 text-xl font-semibold text-text">Pick Your Roles</h2>
      <p className="mb-4 text-sm text-text-muted">
        Choose roles that describe you
      </p>

      <div className="flex flex-wrap gap-2">
        {roles.map((role) => {
          const selected = selectedIds.has(role.id);
          const colorHex = roleColorHex(role.color);

          return (
            <button
              key={role.id}
              type="button"
              onClick={() => toggleRole(role.id)}
              disabled={readOnly}
              className={`flex items-center gap-2 rounded-full border px-4 py-2 text-sm transition-colors ${
                selected
                  ? 'border-accent bg-accent-subtle text-text'
                  : 'border-border bg-bg-surface text-text-muted hover:bg-bg-elevated hover:text-text'
              } ${readOnly ? 'cursor-default' : ''}`}
            >
              {colorHex && (
                <span
                  className="h-3 w-3 rounded-full"
                  style={{ backgroundColor: colorHex }}
                />
              )}
              {role.name}
            </button>
          );
        })}
      </div>
    </div>
  );
}
