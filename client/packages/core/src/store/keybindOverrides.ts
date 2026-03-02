import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { KEYBINDS, type KeybindId } from '../keybinds/keybinds.ts';

const STORAGE_KEY = 'meza:keybind_overrides';

export interface KeybindOverridesState {
  overrides: Partial<Record<KeybindId, string>>;
}

export interface KeybindOverridesActions {
  setOverride: (id: KeybindId, keys: string) => void;
  clearOverride: (id: KeybindId) => void;
  resetAll: () => void;
  getEffectiveKeys: (id: KeybindId) => string;
  getConflicts: (keys: string, excludeId?: KeybindId) => KeybindId[];
}

function loadFromStorage(): Partial<Record<KeybindId, string>> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
      return {};
    const result: Partial<Record<KeybindId, string>> = {};
    const validIds = new Set(Object.keys(KEYBINDS));
    for (const [key, value] of Object.entries(parsed)) {
      if (validIds.has(key) && typeof value === 'string') {
        result[key as KeybindId] = value;
      }
    }
    return result;
  } catch {
    return {};
  }
}

function saveToStorage(overrides: Partial<Record<KeybindId, string>>) {
  try {
    if (Object.keys(overrides).length === 0) {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
    }
  } catch {
    // Storage full or unavailable — silently ignore.
  }
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;
function debouncedSave(
  get: () => KeybindOverridesState & KeybindOverridesActions,
) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveToStorage(get().overrides), 300);
}

export const useKeybindOverridesStore = create<
  KeybindOverridesState & KeybindOverridesActions
>()(
  immer((set, get) => ({
    overrides: loadFromStorage(),

    setOverride: (id, keys) => {
      set((state) => {
        state.overrides[id] = keys;
      });
      debouncedSave(get);
    },

    clearOverride: (id) => {
      set((state) => {
        delete state.overrides[id];
      });
      debouncedSave(get);
    },

    resetAll: () => {
      set((state) => {
        state.overrides = {};
      });
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch {
        // Ignore
      }
    },

    getEffectiveKeys: (id) => {
      const override = get().overrides[id];
      if (override !== undefined) return override;
      return KEYBINDS[id].keys;
    },

    getConflicts: (keys, excludeId) => {
      if (!keys) return [];
      const ids = Object.keys(KEYBINDS) as KeybindId[];
      const conflicts: KeybindId[] = [];
      for (const id of ids) {
        if (id === excludeId) continue;
        const effective = get().getEffectiveKeys(id);
        if (effective && effective.toLowerCase() === keys.toLowerCase()) {
          conflicts.push(id);
        }
      }
      return conflicts;
    },
  })),
);
