import type { DropPosition } from '@meza/core';

/** Threshold to enter an edge zone from center */
const ENTER_BAND = 0.25;
/** Threshold to leave an edge zone back to center (larger = stickier) */
const LEAVE_BAND = 0.35;

/**
 * Determine which drop zone the pointer is in relative to a rect.
 * Accepts the current zone for hysteresis — once in a zone, the pointer
 * must move further past the boundary to leave it.
 */
export function computeDropZone(
  pointerX: number,
  pointerY: number,
  rect: DOMRect,
  swapOnly: boolean,
  currentZone: DropPosition | null,
): DropPosition {
  if (swapOnly) return 'center';

  const relX = (pointerX - rect.left) / rect.width;
  const relY = (pointerY - rect.top) / rect.height;

  // Use a wider band if we're already in that zone (sticky)
  const leftBand = currentZone === 'left' ? LEAVE_BAND : ENTER_BAND;
  const rightBand = currentZone === 'right' ? LEAVE_BAND : ENTER_BAND;
  const topBand = currentZone === 'top' ? LEAVE_BAND : ENTER_BAND;
  const bottomBand = currentZone === 'bottom' ? LEAVE_BAND : ENTER_BAND;

  const inLeft = relX < leftBand;
  const inRight = relX > 1 - rightBand;
  const inTop = relY < topBand;
  const inBottom = relY > 1 - bottomBand;

  if (!inLeft && !inRight && !inTop && !inBottom) return 'center';

  // Corner: resolve to nearest edge, but prefer current zone if still valid
  if ((inLeft || inRight) && (inTop || inBottom)) {
    if (
      currentZone &&
      currentZone !== 'center' &&
      ((currentZone === 'left' && inLeft) ||
        (currentZone === 'right' && inRight) ||
        (currentZone === 'top' && inTop) ||
        (currentZone === 'bottom' && inBottom))
    ) {
      return currentZone;
    }
    const edgeDistX = inLeft ? relX : 1 - relX;
    const edgeDistY = inTop ? relY : 1 - relY;
    if (edgeDistX < edgeDistY) return inLeft ? 'left' : 'right';
    return inTop ? 'top' : 'bottom';
  }

  if (inLeft) return 'left';
  if (inRight) return 'right';
  if (inTop) return 'top';
  return 'bottom';
}
