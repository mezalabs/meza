import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock hardware detection before importing the store
vi.mock('../../utils/hardware.ts', () => ({
  canRunGiga: () => true,
  supportsAudioWorklet: () => true,
}));

const STORAGE_KEY = 'meza:audio_settings';

// Minimal localStorage stub for Node (no jsdom environment)
function createLocalStorageStub() {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
    clear: () => store.clear(),
    get length() {
      return store.size;
    },
    key: (index: number) => [...store.keys()][index] ?? null,
  } satisfies Storage;
}

describe('audioSettings store', () => {
  let useAudioSettingsStore: typeof import('../audioSettings.ts').useAudioSettingsStore;
  let storage: Storage;

  beforeEach(async () => {
    storage = createLocalStorageStub();
    vi.stubGlobal('localStorage', storage);
    vi.resetModules();
    const mod = await import('../audioSettings.ts');
    useAudioSettingsStore = mod.useAudioSettingsStore;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('default state', () => {
    it('defaults to giga when hardware is capable', () => {
      expect(useAudioSettingsStore.getState().noiseCancellationMode).toBe(
        'giga',
      );
    });

    it('defaults echoCancellation and autoGainControl to true', () => {
      const state = useAudioSettingsStore.getState();
      expect(state.echoCancellation).toBe(true);
      expect(state.autoGainControl).toBe(true);
    });
  });

  describe('setNoiseCancellationMode', () => {
    it('sets the mode to off', () => {
      useAudioSettingsStore.getState().setNoiseCancellationMode('off');
      expect(useAudioSettingsStore.getState().noiseCancellationMode).toBe(
        'off',
      );
    });

    it('sets the mode to standard', () => {
      useAudioSettingsStore.getState().setNoiseCancellationMode('standard');
      expect(useAudioSettingsStore.getState().noiseCancellationMode).toBe(
        'standard',
      );
    });

    it('sets the mode to giga', () => {
      useAudioSettingsStore.getState().setNoiseCancellationMode('off');
      useAudioSettingsStore.getState().setNoiseCancellationMode('giga');
      expect(useAudioSettingsStore.getState().noiseCancellationMode).toBe(
        'giga',
      );
    });
  });

  describe('localStorage migration', () => {
    it('migrates old noiseSuppression: true to standard', async () => {
      storage.setItem(
        STORAGE_KEY,
        JSON.stringify({ noiseSuppression: true }),
      );
      vi.resetModules();
      const mod = await import('../audioSettings.ts');
      expect(mod.useAudioSettingsStore.getState().noiseCancellationMode).toBe(
        'standard',
      );
    });

    it('migrates old noiseSuppression: false to off', async () => {
      storage.setItem(
        STORAGE_KEY,
        JSON.stringify({ noiseSuppression: false }),
      );
      vi.resetModules();
      const mod = await import('../audioSettings.ts');
      expect(mod.useAudioSettingsStore.getState().noiseCancellationMode).toBe(
        'off',
      );
    });

    it('uses noiseCancellationMode when present (ignores legacy)', async () => {
      storage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          noiseCancellationMode: 'giga',
          noiseSuppression: false,
        }),
      );
      vi.resetModules();
      const mod = await import('../audioSettings.ts');
      expect(mod.useAudioSettingsStore.getState().noiseCancellationMode).toBe(
        'giga',
      );
    });

    it('ignores invalid noiseCancellationMode values', async () => {
      storage.setItem(
        STORAGE_KEY,
        JSON.stringify({ noiseCancellationMode: 'ultra' }),
      );
      vi.resetModules();
      const mod = await import('../audioSettings.ts');
      // Falls through to smart default (giga, since hardware mock returns true)
      expect(mod.useAudioSettingsStore.getState().noiseCancellationMode).toBe(
        'giga',
      );
    });
  });

  describe('hydrateFromProfile', () => {
    it('hydrates with new noiseCancellationMode field', () => {
      useAudioSettingsStore.getState().hydrateFromProfile({
        noiseCancellationMode: 'standard',
        echoCancellation: false,
        autoGainControl: false,
      });
      const state = useAudioSettingsStore.getState();
      expect(state.noiseCancellationMode).toBe('standard');
      expect(state.echoCancellation).toBe(false);
      expect(state.autoGainControl).toBe(false);
    });

    it('falls back to legacy noiseSuppression when mode absent', () => {
      useAudioSettingsStore.getState().hydrateFromProfile({
        noiseSuppression: true,
        echoCancellation: true,
        autoGainControl: true,
      });
      expect(useAudioSettingsStore.getState().noiseCancellationMode).toBe(
        'standard',
      );
    });

    it('maps legacy noiseSuppression: false to off', () => {
      useAudioSettingsStore.getState().hydrateFromProfile({
        noiseSuppression: false,
        echoCancellation: true,
        autoGainControl: true,
      });
      expect(useAudioSettingsStore.getState().noiseCancellationMode).toBe(
        'off',
      );
    });

    it('keeps current value when neither new nor legacy field present', () => {
      useAudioSettingsStore.getState().hydrateFromProfile({
        echoCancellation: true,
        autoGainControl: true,
      });
      expect(useAudioSettingsStore.getState().noiseCancellationMode).toBe(
        'giga',
      );
    });

    it('prefers noiseCancellationMode over legacy noiseSuppression', () => {
      useAudioSettingsStore.getState().hydrateFromProfile({
        noiseCancellationMode: 'giga',
        noiseSuppression: false,
        echoCancellation: true,
        autoGainControl: true,
      });
      expect(useAudioSettingsStore.getState().noiseCancellationMode).toBe(
        'giga',
      );
    });
  });

  describe('reset', () => {
    it('resets to initial state', () => {
      useAudioSettingsStore.getState().setNoiseCancellationMode('off');
      useAudioSettingsStore.getState().setEchoCancellation(false);
      useAudioSettingsStore.getState().reset();
      const state = useAudioSettingsStore.getState();
      expect(state.noiseCancellationMode).toBe('giga');
      expect(state.echoCancellation).toBe(true);
    });

    it('clears localStorage', () => {
      useAudioSettingsStore.getState().setNoiseCancellationMode('off');
      useAudioSettingsStore.getState().reset();
      expect(storage.getItem(STORAGE_KEY)).toBeNull();
    });
  });
});
