/**
 * Convert an integer color (0–16777215) to a CSS hex string.
 * Returns undefined for 0 (the "no color" sentinel).
 */
export function roleColorHex(color: number): string | undefined {
  if (!color) return undefined;
  return `#${color.toString(16).padStart(6, '0')}`;
}
