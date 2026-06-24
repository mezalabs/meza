/**
 * Pure gesture math + tuning constants for useSwipeBack, split out so the
 * decision logic is unit-testable without importing the hook's runtime
 * dependencies (React, @meza/core haptics).
 */

/** Left dead-zone (px) ignored so OS edge-back gestures (iOS Safari, Android
 *  gesture-nav) stay the sole handler there and we don't double-pop the stack. */
export const EDGE_DEADZONE = 16;
/** Distance commit threshold: dragged past this fraction of width → dismiss. */
export const DISMISS_THRESHOLD = 0.3;
/** Below this travel a gesture never commits, however fast the flick. */
export const MIN_COMMIT_DISTANCE_PX = 48;
export const MIN_COMMIT_DISTANCE_FRACTION = 0.12;
/** Flick velocity (px/ms) that commits even under the distance threshold. */
export const VELOCITY_THRESHOLD = 0.5;
/** Movement (px) before we lock to horizontal-vs-vertical intent. */
export const DIRECTION_LOCK_THRESHOLD = 10;
/** Velocity is averaged over the most recent samples within this window (ms). */
export const VELOCITY_WINDOW_MS = 80;
/** Velocity-matched commit/cancel animation duration bounds (ms). */
export const MIN_DURATION = 140;
export const MAX_DURATION = 320;
/** Decelerate curve — matches --ease-snappy in index.css. */
export const COMMIT_EASE = 'cubic-bezier(0.2, 0, 0, 1)';

export interface TouchSample {
  x: number;
  t: number;
}

/** Average horizontal velocity (px/ms) over the most recent samples. */
export function computeVelocity(samples: TouchSample[]): number {
  if (samples.length < 2) return 0;
  const last = samples[samples.length - 1];
  let start = samples[0];
  for (let i = samples.length - 2; i >= 0; i--) {
    start = samples[i];
    if (last.t - samples[i].t >= VELOCITY_WINDOW_MS) break;
  }
  const dt = last.t - start.t;
  if (dt <= 0) return 0;
  return (last.x - start.x) / dt;
}

/** Commit when past the (lowered) distance threshold OR flicked fast enough,
 *  provided a minimum travel guard is met so a tiny twitch never dismisses. */
export function shouldCommit({
  dx,
  width,
  velocity,
}: {
  dx: number;
  width: number;
  velocity: number;
}): boolean {
  if (width <= 0) return false;
  const minDistance = Math.max(
    MIN_COMMIT_DISTANCE_PX,
    width * MIN_COMMIT_DISTANCE_FRACTION,
  );
  if (dx < minDistance) return false;
  return dx / width > DISMISS_THRESHOLD || velocity > VELOCITY_THRESHOLD;
}

/** Velocity-matched settle duration. Fast gestures finish quickly; slow ones
 *  take longer (capped). Collapses to 0 under prefers-reduced-motion. */
export function commitDuration({
  remainingPx,
  velocity,
  reducedMotion,
}: {
  remainingPx: number;
  velocity: number;
  reducedMotion: boolean;
}): number {
  if (reducedMotion) return 0;
  const speed = Math.abs(velocity);
  const raw = speed > 0.001 ? remainingPx / speed : MAX_DURATION;
  return Math.min(MAX_DURATION, Math.max(MIN_DURATION, raw));
}

/** True if the touch started inside a horizontally-scrollable element (code
 *  blocks, carousels) or one opted out via data-swipe-back-ignore — in which
 *  case the gesture must not arm and steal horizontal scrolling. */
export function startsInHorizontalScroller(
  target: EventTarget | null,
  boundary: HTMLElement,
): boolean {
  let node = target instanceof Element ? target : null;
  const stop = boundary.parentElement;
  while (node && node !== stop) {
    if (node instanceof HTMLElement) {
      if (node.dataset.swipeBackIgnore !== undefined) return true;
      if (node.scrollWidth > node.clientWidth) {
        const overflowX = getComputedStyle(node).overflowX;
        if (overflowX === 'auto' || overflowX === 'scroll') return true;
      }
    }
    node = node.parentElement;
  }
  return false;
}
