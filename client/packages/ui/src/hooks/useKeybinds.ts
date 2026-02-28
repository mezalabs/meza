import {
  KEYBINDS,
  type Keybind,
  type KeybindId,
  matchesKeybind,
  shouldSuppressKeybind,
} from '@meza/core';
import { useEffect, useMemo } from 'react';
import { openSearchPane, useTilingStore } from '../stores/tiling.ts';

interface UseKeybindsOptions {
  onShowShortcuts: () => void;
}

export function useKeybinds({ onShowShortcuts }: UseKeybindsOptions) {
  const actions = useMemo<Record<KeybindId, () => void>>(
    () => ({
      'split-horizontal': () =>
        useTilingStore.getState().splitFocused('horizontal'),
      'split-vertical': () =>
        useTilingStore.getState().splitFocused('vertical'),
      'close-pane': () => useTilingStore.getState().closeFocused(),
      'move-focus-left': () => useTilingStore.getState().moveFocus('left'),
      'move-focus-right': () => useTilingStore.getState().moveFocus('right'),
      'move-focus-up': () => useTilingStore.getState().moveFocus('up'),
      'move-focus-down': () => useTilingStore.getState().moveFocus('down'),
      'cycle-focus': () => useTilingStore.getState().cycleFocus(),
      'reset-layout': () => useTilingStore.getState().resetLayout(),
      search: () => openSearchPane(),
      'show-shortcuts': onShowShortcuts,
    }),
    [onShowShortcuts],
  );

  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if (e.defaultPrevented) return;

      const entries = Object.entries(KEYBINDS) as [KeybindId, Keybind][];

      for (const [id, def] of entries) {
        if (!matchesKeybind(e, def.keys)) continue;
        if (shouldSuppressKeybind(e, def)) continue;

        if (def.hotkeyOptions?.preventDefault !== false) {
          e.preventDefault();
        }
        actions[id]();
        return;
      }
    }

    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [actions]);
}
