import { create } from 'zustand';

/**
 * Session-scoped store for tracking dismissed channel content warnings.
 * Resets on page refresh (no persistence).
 */
interface ContentWarningState {
  /** Set of channel IDs where the user has dismissed the CW interstitial. */
  dismissed: Set<string>;
  /** Set of attachment IDs where the user has revealed the spoiler. */
  revealedSpoilers: Set<string>;
  dismissChannel: (channelId: string) => void;
  revealSpoiler: (attachmentId: string) => void;
  isChannelDismissed: (channelId: string) => boolean;
  isSpoilerRevealed: (attachmentId: string) => boolean;
}

export const useContentWarningStore = create<ContentWarningState>()(
  (set, get) => ({
    dismissed: new Set(),
    revealedSpoilers: new Set(),
    dismissChannel: (channelId) => {
      set((state) => {
        const next = new Set(state.dismissed);
        next.add(channelId);
        return { dismissed: next };
      });
    },
    revealSpoiler: (attachmentId) => {
      set((state) => {
        const next = new Set(state.revealedSpoilers);
        next.add(attachmentId);
        return { revealedSpoilers: next };
      });
    },
    isChannelDismissed: (channelId) => get().dismissed.has(channelId),
    isSpoilerRevealed: (attachmentId) =>
      get().revealedSpoilers.has(attachmentId),
  }),
);
