import { KEYBINDS, type KeybindId } from '@meza/core/keybinds';
import { describe, expect, it } from 'vitest';
import { toElectronAccelerator } from './accelerator.ts';

describe('toElectronAccelerator', () => {
  describe('every default KEYBIND', () => {
    const ids = Object.keys(KEYBINDS) as KeybindId[];
    for (const id of ids) {
      const def = KEYBINDS[id];
      // A binding is globally representable only if it has a modifier.
      // Empty keys (push-to-talk defaults) and bare keys (mark-channel-read
      // defaults to 'escape') are intentionally rejected.
      const hasModifier = def.keys.includes('+');
      it(`${id} (${def.keys || '<unbound>'}) → ${hasModifier ? 'accelerator' : 'null'}`, () => {
        const result = toElectronAccelerator(def.keys);
        if (!hasModifier) {
          expect(result).toBeNull();
        } else {
          expect(result).not.toBeNull();
          expect(result).toMatch(/^[A-Z][A-Za-z+0-9/.,;'\\\-=`\[\]]+$/);
        }
      });
    }
  });

  it.each([
    ['mod+k', 'CommandOrControl+K'],
    ['ctrl+shift+m', 'Control+Shift+M'],
    ['ctrl+shift+d', 'Control+Shift+D'],
    ['shift+/', 'Shift+/'],
    ['ctrl+shift+left', 'Control+Shift+Left'],
    ['ctrl+shift+tab', 'Control+Shift+Tab'],
    ['alt+f4', 'Alt+F4'],
    ['ctrl+1', 'Control+1'],
    ['mod+shift+space', 'CommandOrControl+Shift+Space'],
  ])('maps %s → %s', (input, expected) => {
    expect(toElectronAccelerator(input)).toBe(expected);
  });

  it.each([
    [''],
    ['foo'],            // unknown key, no modifier
    ['mod+'],           // empty primary
    ['+k'],             // empty modifier
    ['escape'],         // bare key, would steal system-wide
    ['tab'],            // bare key
    ['k'],              // bare letter
    ['shift+xxxx'],     // unknown primary
    ['weirdmod+k'],     // unknown modifier
    ['mod+mod+k'],      // duplicate modifier
    ['mod++k'],         // empty middle
  ])('rejects %s → null', (input) => {
    expect(toElectronAccelerator(input)).toBeNull();
  });

  it('rejects non-string input defensively', () => {
    // @ts-expect-error – verifying runtime guard
    expect(toElectronAccelerator(undefined)).toBeNull();
    // @ts-expect-error – verifying runtime guard
    expect(toElectronAccelerator(null)).toBeNull();
    // @ts-expect-error – verifying runtime guard
    expect(toElectronAccelerator(42)).toBeNull();
  });

  it('handles mixed case', () => {
    expect(toElectronAccelerator('CTRL+Shift+M')).toBe('Control+Shift+M');
    expect(toElectronAccelerator('Mod+K')).toBe('CommandOrControl+K');
  });
});
