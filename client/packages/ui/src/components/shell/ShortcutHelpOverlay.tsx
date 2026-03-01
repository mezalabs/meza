import {
  getDisplayKeys,
  KEYBINDS,
  type Keybind,
  type KeybindId,
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

function getOverlayEntries(simpleMode: boolean) {
  const entries = Object.entries(KEYBINDS) as [KeybindId, Keybind][];
  const filtered = simpleMode
    ? entries.filter(([, def]) => !def.tilingOnly)
    : entries;

  const result: { displayKeys: string; label: string }[] = [];
  let addedMoveFocus = false;

  for (const [id, def] of filtered) {
    if (MOVE_FOCUS_IDS.has(id)) {
      if (!addedMoveFocus) {
        result.push({ displayKeys: 'Ctrl+Shift+Arrow', label: 'Move focus' });
        addedMoveFocus = true;
      }
    } else {
      result.push({ displayKeys: getDisplayKeys(id), label: def.label });
    }
  }

  return result;
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
  const shortcuts = useMemo(() => getOverlayEntries(simpleMode), [simpleMode]);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/60 data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out" />
        <Dialog.Content className="fixed left-1/2 top-1/2 w-full max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-xl bg-bg-elevated p-6 shadow-lg data-[state=open]:animate-scale-in data-[state=closed]:animate-scale-out">
          <Dialog.Title className="mb-4 text-lg font-semibold text-text">
            Keyboard Shortcuts
          </Dialog.Title>
          <div className="flex flex-col gap-2">
            {shortcuts.map((s) => (
              <div
                key={s.displayKeys}
                className="flex items-center justify-between"
              >
                <span className="text-sm text-text-muted">{s.label}</span>
                <kbd className="rounded-md bg-bg-surface px-2 py-0.5 font-mono text-xs text-text-subtle">
                  {s.displayKeys}
                </kbd>
              </div>
            ))}
          </div>
          <Dialog.Close className="absolute right-4 top-4 rounded-sm p-1 text-text-subtle hover:bg-bg-surface hover:text-text">
            <XIcon weight="regular" size={14} aria-hidden="true" />
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
