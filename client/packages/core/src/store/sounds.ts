import type { SoundboardSound } from '@meza/gen/meza/v1/models_pb.ts';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

export interface SoundState {
  byServer: Record<string, SoundboardSound[]>;
  personal: SoundboardSound[];
  isLoading: boolean;
  error: string | null;
}

export interface SoundActions {
  setServerSounds: (serverId: string, sounds: SoundboardSound[]) => void;
  setPersonalSounds: (sounds: SoundboardSound[]) => void;
  addSound: (sound: SoundboardSound) => void;
  updateSound: (sound: SoundboardSound) => void;
  removeSound: (soundId: string, serverId?: string) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  reset: () => void;
}

export const useSoundStore = create<SoundState & SoundActions>()(
  immer((set) => ({
    byServer: {},
    personal: [],
    isLoading: false,
    error: null,

    setServerSounds: (serverId, sounds) => {
      set((state) => {
        state.byServer[serverId] = [...sounds].sort((a, b) =>
          a.name.localeCompare(b.name),
        );
        state.isLoading = false;
      });
    },

    setPersonalSounds: (sounds) => {
      set((state) => {
        state.personal = [...sounds].sort((a, b) =>
          a.name.localeCompare(b.name),
        );
        state.isLoading = false;
      });
    },

    addSound: (sound) => {
      set((state) => {
        if (sound.serverId) {
          const list = state.byServer[sound.serverId] ?? [];
          if (list.some((s) => s.id === sound.id)) return;
          list.push(sound);
          list.sort((a, b) => a.name.localeCompare(b.name));
          state.byServer[sound.serverId] = list;
        } else {
          if (state.personal.some((s) => s.id === sound.id)) return;
          state.personal.push(sound);
          state.personal.sort((a, b) => a.name.localeCompare(b.name));
        }
      });
    },

    updateSound: (sound) => {
      set((state) => {
        if (sound.serverId) {
          const list = state.byServer[sound.serverId];
          if (!list) return;
          const idx = list.findIndex((s) => s.id === sound.id);
          if (idx !== -1) {
            list[idx] = sound;
            list.sort((a, b) => a.name.localeCompare(b.name));
          }
        } else {
          const idx = state.personal.findIndex((s) => s.id === sound.id);
          if (idx !== -1) {
            state.personal[idx] = sound;
            state.personal.sort((a, b) => a.name.localeCompare(b.name));
          }
        }
      });
    },

    removeSound: (soundId, serverId) => {
      set((state) => {
        if (serverId) {
          const list = state.byServer[serverId];
          if (!list) return;
          const idx = list.findIndex((s) => s.id === soundId);
          if (idx !== -1) list.splice(idx, 1);
        } else {
          const idx = state.personal.findIndex((s) => s.id === soundId);
          if (idx !== -1) state.personal.splice(idx, 1);
        }
      });
    },

    setLoading: (loading) => {
      set((state) => {
        state.isLoading = loading;
      });
    },

    setError: (error) => {
      set((state) => {
        state.error = error;
        state.isLoading = false;
      });
    },

    reset: () => {
      set((state) => {
        state.byServer = {};
        state.personal = [];
        state.isLoading = false;
        state.error = null;
      });
    },
  })),
);
