import { useCallback, useEffect, useRef } from 'react';
import {
  type OnboardingTipId,
  selectIsDismissed,
  useOnboardingStore,
} from '../stores/onboarding.ts';

/**
 * Returns onMouseEnter/onMouseLeave handlers that trigger an onboarding tip
 * after a sustained hover (dwell). The timer is cleaned up on unmount.
 */
export function useDwellTrigger(tipId: OnboardingTipId, dwellMs = 800) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const show = useOnboardingStore((s) => s.show);
  const isDismissed = useOnboardingStore(selectIsDismissed(tipId));
  const loaded = useOnboardingStore((s) => s.loaded);

  // Cleanup on unmount
  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const onMouseEnter = useCallback(() => {
    if (isDismissed || !loaded) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      // Re-check dismissal state to avoid stale closure
      if (!useOnboardingStore.getState().dismissedTips[tipId]) {
        show(tipId);
      }
    }, dwellMs);
  }, [isDismissed, loaded, show, tipId, dwellMs]);

  const onMouseLeave = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  return { onMouseEnter, onMouseLeave };
}
