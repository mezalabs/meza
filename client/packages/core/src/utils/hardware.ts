/**
 * Checks whether the device has enough resources for GIGA noise cancellation.
 *
 * Heuristic: >= 4 CPU cores AND >= 4GB RAM (or unknown RAM on non-Chromium browsers,
 * which get the benefit of the doubt since deviceMemory is Chromium-only).
 *
 * This is a soft default, not a hard gate — users on low-end devices can still
 * manually select GIGA mode.
 */
export function canRunGiga(): boolean {
  const cores = navigator.hardwareConcurrency ?? 0;
  // navigator.deviceMemory is Chromium-only (Chrome, Edge, Electron).
  // Non-Chromium browsers (Firefox, Safari) return undefined — treat as capable.
  const memory = (navigator as { deviceMemory?: number }).deviceMemory;

  if (cores < 4) return false;
  if (memory !== undefined && memory < 4) return false;

  return true;
}

/**
 * Returns true if AudioWorklet is available in the current environment.
 */
export function supportsAudioWorklet(): boolean {
  return (
    typeof AudioContext !== 'undefined' &&
    typeof AudioContext.prototype.audioWorklet !== 'undefined'
  );
}
