import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

const AUDIO_SETTINGS_KEY = 'meza:audio_settings';

export interface AudioSettingsState {
  // Local (localStorage)
  inputDeviceId: string | null;
  outputDeviceId: string | null;
  inputGain: number; // 0.0–2.0, default 1.0 (100%)
  outputVolume: number; // 0.0–1.0, default 1.0 (100%)
  perUserVolumes: Record<string, number>; // userId -> 0.0–2.0
  soundboardVolume: number; // 0.0–2.0, default 1.0 (incoming soundboard volume)
  hearOwnSoundboard: boolean; // play your own soundboard sounds locally

  // Server-synced
  noiseSuppression: boolean;
  echoCancellation: boolean;
  autoGainControl: boolean;
}

export interface AudioSettingsActions {
  setInputDevice: (deviceId: string | null) => void;
  setOutputDevice: (deviceId: string | null) => void;
  setInputGain: (gain: number) => void;
  setOutputVolume: (volume: number) => void;
  setPerUserVolume: (userId: string, volume: number) => void;
  setSoundboardVolume: (volume: number) => void;
  setHearOwnSoundboard: (enabled: boolean) => void;
  setNoiseSuppression: (enabled: boolean) => void;
  setEchoCancellation: (enabled: boolean) => void;
  setAutoGainControl: (enabled: boolean) => void;
  hydrateFromProfile: (prefs: {
    noiseSuppression: boolean;
    echoCancellation: boolean;
    autoGainControl: boolean;
  }) => void;
  reset: () => void;
}

const initialState: AudioSettingsState = {
  inputDeviceId: null,
  outputDeviceId: null,
  inputGain: 1.0,
  outputVolume: 1.0,
  perUserVolumes: {},
  soundboardVolume: 1.0,
  hearOwnSoundboard: true,
  noiseSuppression: true,
  echoCancellation: true,
  autoGainControl: true,
};

function loadFromStorage(): Partial<AudioSettingsState> {
  try {
    const raw = localStorage.getItem(AUDIO_SETTINGS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    const result: Partial<AudioSettingsState> = {};
    if (typeof parsed.inputDeviceId === 'string')
      result.inputDeviceId = parsed.inputDeviceId;
    if (typeof parsed.outputDeviceId === 'string')
      result.outputDeviceId = parsed.outputDeviceId;
    if (
      typeof parsed.inputGain === 'number' &&
      Number.isFinite(parsed.inputGain)
    )
      result.inputGain = Math.max(0, Math.min(2, parsed.inputGain));
    if (
      typeof parsed.outputVolume === 'number' &&
      Number.isFinite(parsed.outputVolume)
    )
      result.outputVolume = Math.max(0, Math.min(1, parsed.outputVolume));
    if (
      typeof parsed.perUserVolumes === 'object' &&
      parsed.perUserVolumes !== null &&
      !Array.isArray(parsed.perUserVolumes)
    )
      result.perUserVolumes = parsed.perUserVolumes;
    if (
      typeof parsed.soundboardVolume === 'number' &&
      Number.isFinite(parsed.soundboardVolume)
    )
      result.soundboardVolume = Math.max(
        0,
        Math.min(2, parsed.soundboardVolume),
      );
    if (typeof parsed.hearOwnSoundboard === 'boolean')
      result.hearOwnSoundboard = parsed.hearOwnSoundboard;
    if (typeof parsed.noiseSuppression === 'boolean')
      result.noiseSuppression = parsed.noiseSuppression;
    if (typeof parsed.echoCancellation === 'boolean')
      result.echoCancellation = parsed.echoCancellation;
    if (typeof parsed.autoGainControl === 'boolean')
      result.autoGainControl = parsed.autoGainControl;
    return result;
  } catch {
    return {};
  }
}

function saveToStorage(state: AudioSettingsState) {
  try {
    localStorage.setItem(AUDIO_SETTINGS_KEY, JSON.stringify(state));
  } catch {
    // Storage full or unavailable — silently ignore.
  }
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;
function debouncedSave(get: () => AudioSettingsState & AudioSettingsActions) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveToStorage(get()), 300);
}

export const useAudioSettingsStore = create<
  AudioSettingsState & AudioSettingsActions
>()(
  immer((set, get) => ({
    ...initialState,
    ...loadFromStorage(),

    setInputDevice: (deviceId) => {
      set((s) => {
        s.inputDeviceId = deviceId;
      });
      debouncedSave(get);
    },

    setOutputDevice: (deviceId) => {
      set((s) => {
        s.outputDeviceId = deviceId;
      });
      debouncedSave(get);
    },

    setInputGain: (gain) => {
      set((s) => {
        s.inputGain = Math.max(0, Math.min(2, gain));
      });
      debouncedSave(get);
    },

    setOutputVolume: (volume) => {
      set((s) => {
        s.outputVolume = Math.max(0, Math.min(1, volume));
      });
      debouncedSave(get);
    },

    setPerUserVolume: (userId, volume) => {
      set((s) => {
        s.perUserVolumes[userId] = Math.max(0, Math.min(2, volume));
      });
      debouncedSave(get);
    },

    setSoundboardVolume: (volume) => {
      set((s) => {
        s.soundboardVolume = Math.max(0, Math.min(2, volume));
      });
      debouncedSave(get);
    },

    setHearOwnSoundboard: (enabled) => {
      set((s) => {
        s.hearOwnSoundboard = enabled;
      });
      debouncedSave(get);
    },

    setNoiseSuppression: (enabled) => {
      set((s) => {
        s.noiseSuppression = enabled;
      });
      debouncedSave(get);
    },

    setEchoCancellation: (enabled) => {
      set((s) => {
        s.echoCancellation = enabled;
      });
      debouncedSave(get);
    },

    setAutoGainControl: (enabled) => {
      set((s) => {
        s.autoGainControl = enabled;
      });
      debouncedSave(get);
    },

    hydrateFromProfile: (prefs) => {
      set((s) => {
        s.noiseSuppression = prefs.noiseSuppression;
        s.echoCancellation = prefs.echoCancellation;
        s.autoGainControl = prefs.autoGainControl;
      });
      debouncedSave(get);
    },

    reset: () => {
      try {
        localStorage.removeItem(AUDIO_SETTINGS_KEY);
      } catch {
        // Ignore
      }
      set(() => ({ ...initialState }));
    },
  })),
);
