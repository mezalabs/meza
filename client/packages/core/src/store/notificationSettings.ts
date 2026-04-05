import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import type { SoundType } from '../sound/SoundManager.ts';
import { soundManager } from '../sound/SoundManager.ts';

const NOTIFICATION_SETTINGS_KEY = 'meza:notification_settings';

const ALL_SOUND_TYPES: SoundType[] = [
  'message',
  'dm',
  'mention',
  'voice-join',
  'voice-leave',
  'call-connect',
  'call-end',
  'stream-start',
  'stream-end',
  'stream-join',
  'stream-leave',
  'mute',
  'unmute',
];

export type BadgeMode = 'all' | 'mentions_dms' | 'off';

export interface NotificationSettingsState {
  soundEnabled: boolean;
  enabledSounds: Record<SoundType, boolean>;
  notificationVolume: number;
  badgeMode: BadgeMode;
}

export interface NotificationSettingsActions {
  setSoundEnabled: (enabled: boolean) => void;
  setEnabledSound: (type: SoundType, enabled: boolean) => void;
  setNotificationVolume: (volume: number) => void;
  setBadgeMode: (mode: BadgeMode) => void;
  reset: () => void;
}

function defaultEnabledSounds(): Record<SoundType, boolean> {
  const result = {} as Record<SoundType, boolean>;
  for (const type of ALL_SOUND_TYPES) {
    result[type] = true;
  }
  return result;
}

const initialState: NotificationSettingsState = {
  soundEnabled: true,
  enabledSounds: defaultEnabledSounds(),
  notificationVolume: 0.7,
  badgeMode: 'all',
};

function loadFromStorage(): Partial<NotificationSettingsState> {
  try {
    const raw = localStorage.getItem(NOTIFICATION_SETTINGS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    const result: Partial<NotificationSettingsState> = {};
    if (typeof parsed.soundEnabled === 'boolean')
      result.soundEnabled = parsed.soundEnabled;
    if (
      typeof parsed.notificationVolume === 'number' &&
      Number.isFinite(parsed.notificationVolume)
    )
      result.notificationVolume = Math.max(
        0,
        Math.min(1, parsed.notificationVolume),
      );
    if (
      typeof parsed.enabledSounds === 'object' &&
      parsed.enabledSounds !== null &&
      !Array.isArray(parsed.enabledSounds)
    ) {
      const enabled = { ...defaultEnabledSounds() };
      for (const type of ALL_SOUND_TYPES) {
        if (typeof parsed.enabledSounds[type] === 'boolean') {
          enabled[type] = parsed.enabledSounds[type];
        }
      }
      result.enabledSounds = enabled;
    }
    if (
      parsed.badgeMode === 'all' ||
      parsed.badgeMode === 'mentions_dms' ||
      parsed.badgeMode === 'off'
    ) {
      result.badgeMode = parsed.badgeMode;
    }
    return result;
  } catch {
    return {};
  }
}

function saveToStorage(state: NotificationSettingsState) {
  try {
    localStorage.setItem(NOTIFICATION_SETTINGS_KEY, JSON.stringify(state));
  } catch {
    // Storage full or unavailable — silently ignore.
  }
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;
function debouncedSave(
  get: () => NotificationSettingsState & NotificationSettingsActions,
) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveToStorage(get()), 300);
}

export const useNotificationSettingsStore = create<
  NotificationSettingsState & NotificationSettingsActions
>()(
  immer((set, get) => ({
    ...initialState,
    ...loadFromStorage(),

    setSoundEnabled: (enabled) => {
      set((s) => {
        s.soundEnabled = enabled;
      });
      debouncedSave(get);
    },

    setEnabledSound: (type, enabled) => {
      set((s) => {
        s.enabledSounds[type] = enabled;
      });
      debouncedSave(get);
    },

    setNotificationVolume: (volume) => {
      const clamped = Math.max(0, Math.min(1, volume));
      set((s) => {
        s.notificationVolume = clamped;
      });
      soundManager.setVolume(clamped);
      debouncedSave(get);
    },

    setBadgeMode: (mode) => {
      set((s) => {
        s.badgeMode = mode;
      });
      debouncedSave(get);
    },

    reset: () => {
      clearTimeout(saveTimer);
      try {
        localStorage.removeItem(NOTIFICATION_SETTINGS_KEY);
      } catch {
        // Ignore
      }
      set(() => ({ ...initialState }));
      soundManager.setVolume(initialState.notificationVolume);
    },
  })),
);

// Apply initial volume to SoundManager
soundManager.setVolume(
  useNotificationSettingsStore.getState().notificationVolume,
);
