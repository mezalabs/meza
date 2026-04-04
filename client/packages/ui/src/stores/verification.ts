/**
 * Zustand store for safety number verification state.
 *
 * In-memory cache of verification status, hydrated from IndexedDB on session
 * bootstrap. Provides reactive state for UI components (badges, dialogs).
 */

import {
  getVerificationStatus,
  loadAllVerifications,
  onKeyChanged,
  clearVerification as persistClearVerification,
  markVerified as persistVerified,
  type VerificationRecord,
} from '@meza/core';
import { create } from 'zustand';

interface VerificationState {
  /** Map of userId -> verification record (in-memory cache). */
  records: Record<string, VerificationRecord>;
  /** Set of user IDs whose identity key has changed (for warning UI). */
  keyChangedUsers: Set<string>;

  /** Hydrate from IndexedDB on session start. */
  hydrate: () => Promise<void>;
  /** Mark a user as verified (persists to IndexedDB). */
  setVerified: (userId: string, publicKey: Uint8Array) => Promise<void>;
  /** Clear verification for a user (persists to IndexedDB). */
  clearVerified: (userId: string) => Promise<void>;
  /** Handle a key change event: clear verification and track for warnings. */
  onKeyChanged: (userId: string) => Promise<void>;
  /** Check if a user is verified (reads from in-memory cache). */
  isVerified: (userId: string) => boolean;
  /** Check if a user's key has changed since last seen. */
  hasKeyChanged: (userId: string) => boolean;
  /** Clear the key-changed flag for a user (after warning is shown). */
  dismissKeyChange: (userId: string) => void;
}

export const useVerificationStore = create<VerificationState>()((set, get) => ({
  records: {},
  keyChangedUsers: new Set(),

  hydrate: async () => {
    const records = await loadAllVerifications();
    const map: Record<string, VerificationRecord> = {};
    for (const r of records) {
      map[r.userId] = r;
    }
    set({ records: map });

    // Register key change callback so core → UI notifications work
    onKeyChanged((userId) => {
      get().onKeyChanged(userId);
    });
  },

  setVerified: async (userId, publicKey) => {
    await persistVerified(userId, publicKey);
    const record = await getVerificationStatus(userId);
    if (record) {
      set((state) => ({
        records: { ...state.records, [userId]: record },
      }));
    }
  },

  clearVerified: async (userId) => {
    await persistClearVerification(userId);
    set((state) => {
      const { [userId]: _, ...rest } = state.records;
      return { records: rest };
    });
  },

  onKeyChanged: async (userId) => {
    await persistClearVerification(userId);
    set((state) => {
      const { [userId]: _, ...rest } = state.records;
      const changed = new Set(state.keyChangedUsers);
      changed.add(userId);
      return { records: rest, keyChangedUsers: changed };
    });
  },

  isVerified: (userId) => {
    return get().records[userId]?.verified === true;
  },

  hasKeyChanged: (userId) => {
    return get().keyChangedUsers.has(userId);
  },

  dismissKeyChange: (userId) => {
    set((state) => {
      const changed = new Set(state.keyChangedUsers);
      changed.delete(userId);
      return { keyChangedUsers: changed };
    });
  },
}));
