// Mirrors `matchesKeybind` in @meza/core/keybinds — keep the `mod` mapping in
// sync; do NOT make it platform-conditional. Electron's `globalShortcut` accepts
// `CommandOrControl` and resolves it per-platform itself.

const KEY_TO_ACCEL: Record<string, string> = {
  left: 'Left',
  right: 'Right',
  up: 'Up',
  down: 'Down',
  tab: 'Tab',
  escape: 'Escape',
  '/': '/',
  ',': ',',
  '.': '.',
  ';': ';',
  "'": "'",
  '[': '[',
  ']': ']',
  '\\': '\\',
  '-': '-',
  '=': '=',
  '`': '`',
  space: 'Space',
  enter: 'Return',
  return: 'Return',
  backspace: 'Backspace',
  delete: 'Delete',
  insert: 'Insert',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
};
for (const c of 'abcdefghijklmnopqrstuvwxyz') KEY_TO_ACCEL[c] = c.toUpperCase();
for (let n = 0; n <= 9; n++) KEY_TO_ACCEL[String(n)] = String(n);
for (let n = 1; n <= 24; n++) KEY_TO_ACCEL[`f${n}`] = `F${n}`;

const VALID_MODIFIERS = new Set(['mod', 'ctrl', 'shift', 'alt']);

/**
 * Convert a Meza hotkey string (`mod+k`, `ctrl+shift+m`) to the Chromium
 * accelerator format Electron's `globalShortcut.register` expects.
 *
 * Returns `null` for combos that cannot be safely globalised:
 *   - empty string
 *   - no modifier (`escape`, `tab`, bare letter — would steal the key system-wide)
 *   - unknown modifier
 *   - unknown primary key
 */
export function toElectronAccelerator(keys: string): string | null {
  if (typeof keys !== 'string' || keys.length === 0) return null;
  const parts = keys.toLowerCase().split('+');
  if (parts.length === 0) return null;
  const key = parts[parts.length - 1];
  if (!key) return null;
  const mods = parts.slice(0, -1);
  if (mods.length === 0) return null;
  if (mods.some((m) => !m)) return null;

  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of mods) {
    if (!VALID_MODIFIERS.has(m)) return null;
    if (seen.has(m)) return null; // duplicate modifier
    seen.add(m);
    if (m === 'mod') out.push('CommandOrControl');
    else if (m === 'ctrl') out.push('Control');
    else if (m === 'shift') out.push('Shift');
    else if (m === 'alt') out.push('Alt');
  }

  const mapped = KEY_TO_ACCEL[key];
  if (!mapped) return null;
  out.push(mapped);
  return out.join('+');
}
