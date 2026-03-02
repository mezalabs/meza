import {
  displayKeysFor,
  KEYBINDS,
  type Keybind,
  type KeybindCategory,
  type KeybindId,
  useKeybindOverridesStore,
} from '@meza/core';
import { XIcon } from '@phosphor-icons/react';
import * as Dialog from '@radix-ui/react-dialog';
import { useMemo } from 'react';
import { useSimpleMode } from '../../stores/tiling.ts';

/** Collapse individual move-focus-{dir} entries into a single display row. */
const MOVE_FOCUS_IDS = new Set<string>([
  'move-focus-left',
  'move-focus-right',
  'move-focus-up',
  'move-focus-down',
]);

const CATEGORY_LABELS: Record<KeybindCategory, string> = {
  navigation: 'Navigation',
  tiling: 'Tiling',
  voice: 'Voice',
  channels: 'Channels',
};

const CATEGORY_ORDER: KeybindCategory[] = [
  'navigation',
  'tiling',
  'voice',
  'channels',
];

interface OverlayEntry {
  displayKeys: string;
  label: string;
}

function getOverlayEntries(simpleMode: boolean) {
  const entries = Object.entries(KEYBINDS) as [KeybindId, Keybind][];
  const filtered = simpleMode
    ? entries.filter(([, def]) => !def.tilingOnly)
    : entries;

  const grouped: Record<string, OverlayEntry[]> = {};
  let addedMoveFocus = false;

  for (const [id, def] of filtered) {
    const category = def.category ?? 'navigation';
    if (!grouped[category]) grouped[category] = [];

    const effectiveKeys = useKeybindOverridesStore
      .getState()
      .getEffectiveKeys(id);

    if (MOVE_FOCUS_IDS.has(id)) {
      if (!addedMoveFocus) {
        // For move-focus, check if any are overridden
        const allDefault = [
          'move-focus-left',
          'move-focus-right',
          'move-focus-up',
          'move-focus-down',
        ].every(
          (mfId) =>
            !useKeybindOverridesStore.getState().overrides[mfId as KeybindId],
        );
        const displayKeys = allDefault
          ? 'Ctrl+Shift+Arrow'
          : displayKeysFor(effectiveKeys);
        grouped[category].push({ displayKeys, label: 'Move focus' });
        addedMoveFocus = true;
      }
    } else {
      grouped[category].push({
        displayKeys: effectiveKeys ? displayKeysFor(effectiveKeys) : 'Not set',
        label: def.label,
      });
    }
  }

  return grouped;
}

interface ShortcutHelpOverlayProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ShortcutHelpOverlay({
  open,
  onOpenChange,
}: ShortcutHelpOverlayProps) {
  const simpleMode = useSimpleMode();
  const overrides = useKeybindOverridesStore((s) => s.overrides);
  // biome-ignore lint/correctness/useExhaustiveDependencies: overrides triggers re-render when keybinds change
  const grouped = useMemo(
    () => getOverlayEntries(simpleMode),
    [simpleMode, overrides],
  );

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/60 data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out" />
        <Dialog.Content className="fixed left-1/2 top-1/2 w-full max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-xl bg-bg-elevated p-6 shadow-lg data-[state=open]:animate-scale-in data-[state=closed]:animate-scale-out">
          <Dialog.Title className="mb-4 text-lg font-semibold text-text">
            Keyboard Shortcuts
          </Dialog.Title>
          <div className="flex flex-col gap-4">
            {CATEGORY_ORDER.map((category) => {
              const entries = grouped[category];
              if (!entries || entries.length === 0) return null;
              return (
                <div key={category}>
                  <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-text-subtle">
                    {CATEGORY_LABELS[category]}
                  </h3>
                  <div className="flex flex-col gap-1.5">
                    {entries.map((s) => (
                      <div
                        key={s.label}
                        className="flex items-center justify-between"
                      >
                        <span className="text-sm text-text-muted">
                          {s.label}
                        </span>
                        <kbd
                          className={`rounded-md px-2 py-0.5 font-mono text-xs ${
                            s.displayKeys === 'Not set'
                              ? 'text-text-subtle italic'
                              : 'bg-bg-surface text-text-subtle'
                          }`}
                        >
                          {s.displayKeys}
                        </kbd>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
          <Dialog.Close className="absolute right-4 top-4 rounded-sm p-1 text-text-subtle hover:bg-bg-surface hover:text-text">
            <XIcon weight="regular" size={14} aria-hidden="true" />
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
