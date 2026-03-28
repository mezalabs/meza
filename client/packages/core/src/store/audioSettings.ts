import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { canRunGiga, supportsAudioWorklet } from '../utils/hardware.ts';

const AUDIO_SETTINGS_KEY = 'meza:audio_settings';

export type NoiseCancellationMode = 'off' | 'standard' | 'giga';

export interface AudioSettingsState {
  // Local (localStorage)
  inputDeviceId: string | null;
  outputDeviceId: string | null;
  inputGain: number; // 0.0–2.0, default 1.0 (100%)
  outputVolume: number; // 0.0–1.0, default 1.0 (100%)
  perUserVolumes: Record<string, number>; // userId -> 0.0–2.0
  soundboardVolume: number; // 0.0–2.0, default 1.0 (incoming soundboard volume)
  hearOwnSoundboard: boolean; // play your own soundboard sounds locally

  // GIGA noise gate threshold (0–100). Frames with VAD probability below
  // this percentage are silenced. 0 = no gating (RNNoise output only).
  gigaThreshold: number;

  // Server-synced
  noiseCancellationMode: NoiseCancellationMode;
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
  setGigaThreshold: (threshold: number) => void;
  setNoiseCancellationMode: (mode: NoiseCancellationMode) => void;
  setEchoCancellation: (enabled: boolean) => void;
  setAutoGainControl: (enabled: boolean) => void;
  hydrateFromProfile: (prefs: {
    noiseCancellationMode?: NoiseCancellationMode;
    // Legacy fields for migration
    noiseSuppression?: boolean;
    echoCancellation: boolean;
    autoGainControl: boolean;
  }) => void;
  reset: () => void;
}

/** Smart default: GIGA if hardware supports it, else Standard. */
function defaultNoiseCancellationMode(): NoiseCancellationMode {
  if (supportsAudioWorklet() && canRunGiga()) return 'giga';
  return 'standard';
}

const initialState: AudioSettingsState = {
  inputDeviceId: null,
  outputDeviceId: null,
  inputGain: 1.0,
  outputVolume: 1.0,
  perUserVolumes: {},
  soundboardVolume: 1.0,
  hearOwnSoundboard: true,
  gigaThreshold: 50,
  noiseCancellationMode: defaultNoiseCancellationMode(),
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
    if (
      typeof parsed.gigaThreshold === 'number' &&
      Number.isFinite(parsed.gigaThreshold)
    )
      result.gigaThreshold = Math.max(0, Math.min(100, parsed.gigaThreshold));

    // New field: noiseCancellationMode
    if (
      typeof parsed.noiseCancellationMode === 'string' &&
      ['off', 'standard', 'giga'].includes(parsed.noiseCancellationMode)
    ) {
      result.noiseCancellationMode =
        parsed.noiseCancellationMode as NoiseCancellationMode;
    } else if (typeof parsed.noiseSuppression === 'boolean') {
      // Migration: old boolean -> new mode
      result.noiseCancellationMode = parsed.noiseSuppression
        ? 'standard'
        : 'off';
    }

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

    setGigaThreshold: (threshold) => {
      set((s) => {
        s.gigaThreshold = Math.max(0, Math.min(100, threshold));
      });
      debouncedSave(get);
    },

    setNoiseCancellationMode: (mode) => {
      set((s) => {
        s.noiseCancellationMode = mode;
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
        // New field takes precedence if present
        if (
          prefs.noiseCancellationMode &&
          ['off', 'standard', 'giga'].includes(prefs.noiseCancellationMode)
        ) {
          s.noiseCancellationMode = prefs.noiseCancellationMode;
        } else if (prefs.noiseSuppression !== undefined) {
          // Legacy migration: existing user with old boolean
          s.noiseCancellationMode = prefs.noiseSuppression ? 'standard' : 'off';
        }
        // If neither is present, keep the current value (smart default for new users)

        s.echoCancellation = prefs.echoCancellation;
        s.autoGainControl = prefs.autoGainControl;
      });
      debouncedSave(get);
    },

    reset: () => {
      clearTimeout(saveTimer);
      try {
        localStorage.removeItem(AUDIO_SETTINGS_KEY);
      } catch {
        // Ignore
      }
      set(() => ({ ...initialState }));
    },
  })),
);
