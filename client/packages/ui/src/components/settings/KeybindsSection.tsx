import {
  type ElectronKeybindGlobalStatus,
  isElectron,
  isGlobalEligible,
  KEYBINDS,
  type Keybind,
  type KeybindCategory,
  type KeybindId,
  useKeybindGlobalStatusStore,
  useKeybindOverridesStore,
} from '@meza/core';
import { ArrowCounterClockwiseIcon } from '@phosphor-icons/react';
import { useState } from 'react';
import { KeybindRecorder } from './KeybindRecorder.tsx';

const CATEGORY_LABELS: Record<KeybindCategory, string> = {
  navigation: 'Navigation',
  tiling: 'Tiling (multi-pane only)',
  voice: 'Voice (connected only)',
  channels: 'Channels',
};

const CATEGORY_ORDER: KeybindCategory[] = [
  'navigation',
  'voice',
  'channels',
  'tiling',
];

const STATUS_LABEL: Record<ElectronKeybindGlobalStatus, string> = {
  active: 'Global',
  failed: 'In use by another app',
  unsupported: 'Unsupported combo',
  permission: 'Permission needed',
};

const STATUS_CLASS: Record<ElectronKeybindGlobalStatus, string> = {
  active: 'bg-success/15 text-success',
  failed: 'bg-warning/15 text-warning',
  unsupported: 'bg-bg-surface text-text-subtle',
  permission: 'bg-warning/15 text-warning',
};

function StatusPill({ status }: { status: ElectronKeybindGlobalStatus }) {
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${STATUS_CLASS[status]}`}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

export function KeybindsSection() {
  const overrides = useKeybindOverridesStore((s) => s.overrides);
  const status = useKeybindGlobalStatusStore((s) => s.status);
  const [editingId, setEditingId] = useState<KeybindId | null>(null);
  const [pendingHoldEnable, setPendingHoldEnable] = useState<Set<KeybindId>>(
    () => new Set(),
  );
  const showGlobalControls = isElectron();

  const entries = Object.entries(KEYBINDS) as [KeybindId, Keybind][];
  const grouped = new Map<KeybindCategory, [KeybindId, Keybind][]>();
  for (const [id, def] of entries) {
    const category = def.category ?? 'navigation';
    if (!grouped.has(category)) grouped.set(category, []);
    const list = grouped.get(category);
    if (list) list.push([id, def]);
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-lg font-semibold text-text">Keybinds</h2>
        <p className="mt-1 text-sm text-text-muted">
          Customize keyboard shortcuts. Click "Edit" to record a new binding.
          {showGlobalControls && (
            <>
              {' '}
              Toggle <span className="font-medium">Global</span> to capture a
              binding even when Meza isn't focused.
            </>
          )}
        </p>
      </div>

      {CATEGORY_ORDER.map((category) => {
        const items = grouped.get(category);
        if (!items || items.length === 0) return null;
        return (
          <div key={category}>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-text-subtle">
              {CATEGORY_LABELS[category]}
            </h3>
            <div className="flex flex-col divide-y divide-border/40">
              {items.map(([id, def]) => {
                const effectiveKeys = useKeybindOverridesStore
                  .getState()
                  .getEffectiveKeys(id);
                const isOverridden = overrides[id]?.keys !== undefined;
                const isEditing = editingId === id;
                const isGlobal = useKeybindOverridesStore
                  .getState()
                  .getEffectiveIsGlobal(id);
                const eligible = showGlobalControls && isGlobalEligible(id);
                const bindingStatus = status[id];

                return (
                  <div
                    key={id}
                    className="flex items-center justify-between py-2"
                  >
                    <div className="flex flex-col">
                      <span className="text-sm text-text">{def.label}</span>
                      {def.type === 'hold' && (
                        <span className="text-xs text-text-subtle">
                          Hold to activate
                        </span>
                      )}
                    </div>

                    <div className="flex items-center gap-2">
                      {eligible && (
                        <>
                          {isGlobal && bindingStatus && (
                            <StatusPill status={bindingStatus} />
                          )}
                          <label
                            className={`flex items-center gap-1.5 text-xs text-text-subtle hover:text-text ${
                              pendingHoldEnable.has(id)
                                ? 'cursor-wait opacity-60'
                                : 'cursor-pointer'
                            }`}
                          >
                            <input
                              type="checkbox"
                              checked={isGlobal}
                              disabled={pendingHoldEnable.has(id)}
                              onChange={async (e) => {
                                const next = e.target.checked;
                                const needsOptIn =
                                  next &&
                                  def.type === 'hold' &&
                                  !!window.electronAPI;
                                // Optimistic apply: the user's last click is
                                // immediately reflected. If the OS-level
                                // opt-in fails, we roll back. The input is
                                // disabled while pending so the user can't
                                // click again mid-await and produce a stale
                                // resolution that overwrites their intent.
                                useKeybindOverridesStore
                                  .getState()
                                  .setGlobal(id, next);
                                if (!needsOptIn) return;
                                setPendingHoldEnable((prev) => {
                                  const n = new Set(prev);
                                  n.add(id);
                                  return n;
                                });
                                try {
                                  const result =
                                    await window.electronAPI!.keybinds.enableHoldGlobals();
                                  if (!result.ok) {
                                    useKeybindOverridesStore
                                      .getState()
                                      .setGlobal(id, false);
                                  }
                                } finally {
                                  setPendingHoldEnable((prev) => {
                                    if (!prev.has(id)) return prev;
                                    const n = new Set(prev);
                                    n.delete(id);
                                    return n;
                                  });
                                }
                              }}
                              className="cursor-inherit"
                              aria-label={`Capture ${def.label} globally`}
                            />
                            Global
                          </label>
                        </>
                      )}
                      {isEditing ? (
                        <KeybindRecorder
                          keybindId={id}
                          currentKeys={effectiveKeys}
                          onDone={() => setEditingId(null)}
                        />
                      ) : (
                        <>
                          <KeybindRecorder
                            keybindId={id}
                            currentKeys={effectiveKeys}
                            onDone={() => setEditingId(null)}
                          />
                          {isOverridden && (
                            <button
                              type="button"
                              onClick={() =>
                                useKeybindOverridesStore
                                  .getState()
                                  .clearOverride(id)
                              }
                              className="rounded p-1 text-text-subtle hover:bg-bg-surface hover:text-text"
                              title="Reset to default"
                            >
                              <ArrowCounterClockwiseIcon
                                size={14}
                                aria-hidden="true"
                              />
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}

      {/* Reset all */}
      {Object.keys(overrides).length > 0 && (
        <div className="border-t border-border/40 pt-4">
          <button
            type="button"
            onClick={() => useKeybindOverridesStore.getState().resetAll()}
            className="flex items-center gap-2 rounded-md px-3 py-2 text-sm text-text-muted hover:bg-bg-surface hover:text-text transition-colors"
          >
            <ArrowCounterClockwiseIcon size={14} aria-hidden="true" />
            Reset all to defaults
          </button>
        </div>
      )}
    </div>
  );
}
