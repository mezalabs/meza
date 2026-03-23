import { create } from 'zustand';

// ---- Tip ID type (compile-time safety) ----

export const ONBOARDING_TIP_IDS = [
  'sidebar-drag',
  'resize',
  'header-drag',
  'shortcuts',
] as const;

export type OnboardingTipId = (typeof ONBOARDING_TIP_IDS)[number];

// ---- Selectors ----

export const selectIsDismissed = (tipId: OnboardingTipId) =>
  (state: OnboardingState) => tipId in state.dismissedTips;

// ---- Store ----

interface OnboardingState {
  /** Record of dismissed tip IDs. Uses Record for immer-safe O(1) lookups. */
  dismissedTips: Record<string, true>;
  /** Whether dismissed tips have been loaded from the user object. */
  loaded: boolean;
  /** Currently visible tooltip (mutex — only one at a time). */
  activeTip: OnboardingTipId | null;
}

interface OnboardingActions {
  /** Load dismissed tips from user object (called once on Shell mount). */
  load: (dismissedTips: string[]) => void;
  /** Mark a tip as dismissed (local only — caller handles server persistence). */
  dismiss: (tipId: OnboardingTipId) => void;
  /** Request showing a tip. No-op if another tip is active or this one is dismissed. */
  show: (tipId: OnboardingTipId) => void;
  /** Hide the active tip without dismissing it. */
  hide: () => void;
  /** Reset all dismissed tips (for "Reset onboarding tips" in settings). */
  reset: () => void;
}

export const useOnboardingStore = create<OnboardingState & OnboardingActions>()(
  (set, get) => ({
    dismissedTips: {},
    loaded: false,
    activeTip: null,

    load: (tips) =>
      set({
        dismissedTips: Object.fromEntries(
          tips.map((t) => [t, true as const]),
        ),
        loaded: true,
      }),

    dismiss: (tipId) =>
      set((s) => ({
        dismissedTips: { ...s.dismissedTips, [tipId]: true as const },
        activeTip: null,
      })),

    show: (tipId) => {
      const s = get();
      if (s.dismissedTips[tipId] || s.activeTip !== null) return;
      set({ activeTip: tipId });
    },

    hide: () => set({ activeTip: null }),

    reset: () =>
      set({
        dismissedTips: {},
        activeTip: null,
        loaded: true,
      }),
  }),
);
