import { useCallback, useEffect, useRef } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { X } from '@phosphor-icons/react';
import { dismissTip, updateProfile } from '@meza/core';
import {
  type OnboardingTipId,
  ONBOARDING_TIP_IDS,
  useOnboardingStore,
} from '../../stores/onboarding.ts';

interface OnboardingTooltipProps {
  tipId: OnboardingTipId;
  anchorRef: React.RefObject<HTMLElement | null>;
  message: string;
  side?: 'top' | 'right' | 'bottom' | 'left';
  sideOffset?: number;
}

const AUTO_DISMISS_MS = 10_000;

export function OnboardingTooltip({
  tipId,
  anchorRef,
  message,
  side = 'bottom',
  sideOffset = 8,
}: OnboardingTooltipProps) {
  const activeTip = useOnboardingStore((s) => s.activeTip);
  const dismiss = useOnboardingStore((s) => s.dismiss);
  const isOpen = activeTip === tipId;
  const timerRef = useRef<ReturnType<typeof setTimeout>>(null);

  const handleDismiss = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    dismiss(tipId);
    // Fire-and-forget server persistence
    dismissTip(tipId);
  }, [dismiss, tipId]);

  const handleDismissAll = useCallback(() => {
    const { dismiss: d } = useOnboardingStore.getState();
    for (const id of ONBOARDING_TIP_IDS) {
      d(id);
    }
    // Single batch RPC instead of N individual calls
    updateProfile({ dismissTips: [...ONBOARDING_TIP_IDS] }).catch(() => {});
  }, []);

  // Auto-dismiss after 10s
  useEffect(() => {
    if (!isOpen) return;
    timerRef.current = setTimeout(handleDismiss, AUTO_DISMISS_MS);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [isOpen, handleDismiss]);

  if (!isOpen || !anchorRef.current) return null;

  return (
    <Popover.Root open onOpenChange={() => handleDismiss()}>
      <Popover.Anchor virtualRef={anchorRef as React.RefObject<HTMLElement>} />
      <Popover.Portal>
        <Popover.Content
          aria-live="polite"
          role="status"
          side={side}
          sideOffset={sideOffset}
          align="center"
          avoidCollisions
          collisionPadding={16}
          className="z-50 w-72 rounded-lg border-l-2 border-l-accent border border-border bg-bg-overlay p-3 shadow-lg origin-[var(--radix-popover-content-transform-origin)] data-[state=open]:animate-scale-in data-[state=closed]:animate-scale-out"
          onOpenAutoFocus={(e) => e.preventDefault()}
          onEscapeKeyDown={() => handleDismiss()}
          onPointerDownOutside={() => handleDismiss()}
        >
          <div className="flex items-start justify-between gap-2">
            <span className="text-[10px] font-medium uppercase tracking-wider text-accent">
              Tip
            </span>
            <Popover.Close
              aria-label="Dismiss tip"
              className="rounded p-0.5 text-text-muted hover:text-text transition-colors"
              onClick={handleDismiss}
            >
              <X size={12} weight="bold" />
            </Popover.Close>
          </div>
          <p className="mt-1 text-sm text-text leading-relaxed">{message}</p>
          <div className="mt-3 flex items-center justify-between">
            <button
              type="button"
              onClick={handleDismissAll}
              className="text-xs text-text-muted hover:text-text transition-colors"
            >
              Don't show tips
            </button>
            <button
              type="button"
              onClick={handleDismiss}
              className="rounded-md bg-accent px-3 py-1 text-xs font-medium text-white hover:bg-accent/90 transition-colors"
            >
              Got it
            </button>
          </div>
          <Popover.Arrow className="fill-bg-overlay" />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
