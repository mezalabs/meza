import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { KEYBINDS, type KeybindId } from '../keybinds/keybinds.ts';

const STORAGE_KEY = 'meza:keybind_overrides';

/**
 * Per-binding user preferences. Both fields are optional; absent fields fall
 * back to the defaults baked into KEYBINDS.
 *
 * Schema-evolved from `string` (just custom keys) → `{ keys?, isGlobal? }`.
 * The `loadFromStorage` migration accepts the legacy shape.
 */
export interface KeybindOverride {
  keys?: string;
  isGlobal?: boolean;
}

export interface KeybindOverridesState {
  overrides: Partial<Record<KeybindId, KeybindOverride>>;
}

export interface KeybindOverridesActions {
  setOverride: (id: KeybindId, keys: string) => void;
  clearOverride: (id: KeybindId) => void;
  setGlobal: (id: KeybindId, isGlobal: boolean) => void;
  resetAll: () => void;
  getEffectiveKeys: (id: KeybindId) => string;
  getEffectiveIsGlobal: (id: KeybindId) => boolean;
  getGloballyEnabled: () => KeybindId[];
  getConflicts: (keys: string, excludeId?: KeybindId) => KeybindId[];
}

/** Exported for direct testing of the legacy → new schema migration. */
export function loadFromStorage(): Partial<Record<KeybindId, KeybindOverride>> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
      return {};
    const result: Partial<Record<KeybindId, KeybindOverride>> = {};
    const validIds = new Set(Object.keys(KEYBINDS));
    for (const [key, value] of Object.entries(parsed)) {
      if (!validIds.has(key)) continue;
      // Legacy shape: a bare string was the custom keys.
      if (typeof value === 'string') {
        result[key as KeybindId] = { keys: value };
        continue;
      }
      if (typeof value !== 'object' || value === null || Array.isArray(value))
        continue;
      const entry: KeybindOverride = {};
      const v = value as Record<string, unknown>;
      if (typeof v.keys === 'string') entry.keys = v.keys;
      if (typeof v.isGlobal === 'boolean') entry.isGlobal = v.isGlobal;
      if (entry.keys !== undefined || entry.isGlobal !== undefined) {
        result[key as KeybindId] = entry;
      }
    }
    return result;
  } catch {
    return {};
  }
}

function saveToStorage(overrides: Partial<Record<KeybindId, KeybindOverride>>) {
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

function pruneIfEmpty(
  state: KeybindOverridesState,
  id: KeybindId,
) {
  const entry = state.overrides[id];
  if (entry && entry.keys === undefined && entry.isGlobal === undefined) {
    delete state.overrides[id];
  }
}

export const useKeybindOverridesStore = create<
  KeybindOverridesState & KeybindOverridesActions
>()(
  immer((set, get) => ({
    overrides: loadFromStorage(),

    setOverride: (id, keys) => {
      set((state) => {
        const existing = state.overrides[id] ?? {};
        state.overrides[id] = { ...existing, keys };
      });
      debouncedSave(get);
    },

    clearOverride: (id) => {
      set((state) => {
        const existing = state.overrides[id];
        if (!existing) return;
        if (existing.isGlobal === undefined) {
          delete state.overrides[id];
        } else {
          state.overrides[id] = { isGlobal: existing.isGlobal };
        }
      });
      debouncedSave(get);
    },

    setGlobal: (id, isGlobal) => {
      set((state) => {
        const existing = state.overrides[id] ?? {};
        state.overrides[id] = { ...existing, isGlobal };
        // Default state (false) doesn't need to be persisted.
        if (isGlobal === false) {
          delete state.overrides[id].isGlobal;
          pruneIfEmpty(state, id);
        }
      });
      debouncedSave(get);
    },

    resetAll: () => {
      clearTimeout(saveTimer);
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
      const override = get().overrides[id]?.keys;
      if (override !== undefined) return override;
      return KEYBINDS[id].keys;
    },

    getEffectiveIsGlobal: (id) => {
      return get().overrides[id]?.isGlobal === true;
    },

    getGloballyEnabled: () => {
      const ids = Object.keys(get().overrides) as KeybindId[];
      return ids.filter((id) => get().overrides[id]?.isGlobal === true);
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
