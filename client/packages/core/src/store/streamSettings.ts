import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ScreenSharePresetKey =
  | 'h360fps3'
  | 'h360fps15'
  | 'h720fps5'
  | 'h720fps15'
  | 'h720fps30'
  | 'h1080fps15'
  | 'h1080fps30'
  | 'original';

export type ContentHint = 'detail' | 'motion';
export type ViewerQuality = 'auto' | 'low' | 'medium' | 'high';

export interface StreamSettingsState {
  // Publisher
  preset: ScreenSharePresetKey;
  contentHint: ContentHint;
  simulcast: boolean;

  // Viewer
  defaultQuality: ViewerQuality;
}

export interface StreamSettingsActions {
  setPreset: (preset: ScreenSharePresetKey) => void;
  setContentHint: (hint: ContentHint) => void;
  setSimulcast: (enabled: boolean) => void;
  setDefaultQuality: (quality: ViewerQuality) => void;
  reset: () => void;
}

// ---------------------------------------------------------------------------
// localStorage persistence
// ---------------------------------------------------------------------------

const STREAM_SETTINGS_KEY = 'meza:stream_settings';

const initialState: StreamSettingsState = {
  preset: 'h1080fps30',
  contentHint: 'detail',
  simulcast: false,
  defaultQuality: 'auto',
};

const VALID_PRESETS: ReadonlySet<string> = new Set([
  'h360fps3',
  'h360fps15',
  'h720fps5',
  'h720fps15',
  'h720fps30',
  'h1080fps15',
  'h1080fps30',
  'original',
]);
const VALID_HINTS: ReadonlySet<string> = new Set(['detail', 'motion']);
const VALID_QUALITIES: ReadonlySet<string> = new Set([
  'auto',
  'low',
  'medium',
  'high',
]);

function loadFromStorage(): Partial<StreamSettingsState> {
  try {
    const raw = localStorage.getItem(STREAM_SETTINGS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    const result: Partial<StreamSettingsState> = {};
    if (typeof parsed.preset === 'string' && VALID_PRESETS.has(parsed.preset))
      result.preset = parsed.preset as ScreenSharePresetKey;
    if (
      typeof parsed.contentHint === 'string' &&
      VALID_HINTS.has(parsed.contentHint)
    )
      result.contentHint = parsed.contentHint as ContentHint;
    if (typeof parsed.simulcast === 'boolean')
      result.simulcast = parsed.simulcast;
    if (
      typeof parsed.defaultQuality === 'string' &&
      VALID_QUALITIES.has(parsed.defaultQuality)
    )
      result.defaultQuality = parsed.defaultQuality as ViewerQuality;
    return result;
  } catch {
    return {};
  }
}

function saveToStorage(state: StreamSettingsState) {
  try {
    localStorage.setItem(STREAM_SETTINGS_KEY, JSON.stringify(state));
  } catch {
    // Storage full or unavailable — silently ignore.
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useStreamSettingsStore = create<
  StreamSettingsState & StreamSettingsActions
>()(
  immer((set, get) => ({
    ...initialState,
    ...loadFromStorage(),

    setPreset: (preset) => {
      set((s) => {
        s.preset = preset;
      });
      saveToStorage(get());
    },

    setContentHint: (hint) => {
      set((s) => {
        s.contentHint = hint;
      });
      saveToStorage(get());
    },

    setSimulcast: (enabled) => {
      set((s) => {
        s.simulcast = enabled;
      });
      saveToStorage(get());
    },

    setDefaultQuality: (quality) => {
      set((s) => {
        s.defaultQuality = quality;
      });
      saveToStorage(get());
    },

    reset: () => {
      try {
        localStorage.removeItem(STREAM_SETTINGS_KEY);
      } catch {
        // Ignore
      }
      set(() => ({ ...initialState }));
    },
  })),
);
