import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { HOME_INSTANCE } from '../gateway/gateway.ts';

const INSTANCES_KEY = 'meza:instances';

export type InstanceCapabilities = {
  protocolVersion: number;
  mediaEnabled: boolean;
  voiceEnabled: boolean;
  notificationsEnabled: boolean;
};

export type Instance =
  | { status: 'connecting'; url: string }
  | {
      status: 'connected';
      url: string;
      accessToken: string;
      refreshToken: string;
      capabilities: InstanceCapabilities;
    }
  | {
      status: 'reconnecting';
      url: string;
      accessToken: string;
      refreshToken: string;
      attempt: number;
    }
  | { status: 'error'; url: string; error: string };

export interface InstanceState {
  instances: Record<string, Instance>;
}

export interface InstanceActions {
  addInstance: (url: string) => void;
  removeInstance: (url: string) => void;
  updateInstanceStatus: (url: string, instance: Instance) => void;
  updateInstanceTokens: (
    url: string,
    accessToken: string,
    refreshToken: string,
  ) => void;
  getInstance: (url: string) => Instance | undefined;
  reset: () => void;
}

function loadInstanceUrls(): string[] {
  try {
    const raw = localStorage.getItem(INSTANCES_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as string[];
  } catch {
    return [];
  }
}

function persistInstanceUrls(instances: Record<string, Instance>): void {
  try {
    const urls = Object.keys(instances).filter((k) => k !== HOME_INSTANCE);
    localStorage.setItem(INSTANCES_KEY, JSON.stringify(urls));
  } catch {
    // SSR / test environments
  }
}

function buildInitialInstances(): Record<string, Instance> {
  const result: Record<string, Instance> = {};
  for (const url of loadInstanceUrls()) {
    result[url] = { status: 'connecting', url };
  }
  return result;
}

export const useInstanceStore = create<InstanceState & InstanceActions>()(
  immer((set, get) => ({
    instances: buildInitialInstances(),

    addInstance: (url) => {
      set((state) => {
        if (state.instances[url]) return;
        state.instances[url] = { status: 'connecting', url };
      });
      persistInstanceUrls(get().instances);
    },

    removeInstance: (url) => {
      set((state) => {
        delete state.instances[url];
      });
      persistInstanceUrls(get().instances);
    },

    updateInstanceStatus: (url, instance) => {
      set((state) => {
        state.instances[url] = instance;
      });
    },

    updateInstanceTokens: (url, accessToken, refreshToken) => {
      set((state) => {
        const inst = state.instances[url];
        if (!inst) return;
        if (inst.status === 'connected' || inst.status === 'reconnecting') {
          inst.accessToken = accessToken;
          inst.refreshToken = refreshToken;
        }
      });
    },

    getInstance: (url) => {
      return get().instances[url];
    },

    reset: () => {
      set((state) => {
        state.instances = {};
      });
      try {
        localStorage.removeItem(INSTANCES_KEY);
      } catch {
        // SSR / test environments
      }
    },
  })),
);
