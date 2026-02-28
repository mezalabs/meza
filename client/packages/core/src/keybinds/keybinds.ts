export interface Keybind {
  /** Key combo in hotkey format: 'ctrl+shift+v', 'mod+k' */
  keys: string;
  /** Short label for the help overlay */
  label: string;
  /** Hidden in simple mode (single-pane layout) */
  tilingOnly?: boolean;
  /** Options passed to the key event handler */
  hotkeyOptions?: {
    /** Fire even when a form element (input/textarea/select) is focused */
    enableOnFormTags?: boolean;
    /** Call e.preventDefault() on match (default: true) */
    preventDefault?: boolean;
  };
}

export const KEYBINDS = {
  'split-horizontal': {
    keys: 'ctrl+shift+v',
    label: 'Split right',
    tilingOnly: true,
    hotkeyOptions: { preventDefault: true },
  },
  'split-vertical': {
    keys: 'ctrl+shift+h',
    label: 'Split down',
    tilingOnly: true,
    hotkeyOptions: { preventDefault: true },
  },
  'close-pane': {
    keys: 'ctrl+shift+w',
    label: 'Close pane',
    tilingOnly: true,
    hotkeyOptions: { preventDefault: true },
  },
  'move-focus-left': {
    keys: 'ctrl+shift+left',
    label: 'Move focus left',
    tilingOnly: true,
    hotkeyOptions: { preventDefault: true },
  },
  'move-focus-right': {
    keys: 'ctrl+shift+right',
    label: 'Move focus right',
    tilingOnly: true,
    hotkeyOptions: { preventDefault: true },
  },
  'move-focus-up': {
    keys: 'ctrl+shift+up',
    label: 'Move focus up',
    tilingOnly: true,
    hotkeyOptions: { preventDefault: true },
  },
  'move-focus-down': {
    keys: 'ctrl+shift+down',
    label: 'Move focus down',
    tilingOnly: true,
    hotkeyOptions: { preventDefault: true },
  },
  'cycle-focus': {
    keys: 'ctrl+shift+tab',
    label: 'Cycle focus',
    tilingOnly: true,
    hotkeyOptions: { preventDefault: true },
  },
  'reset-layout': {
    keys: 'ctrl+shift+e',
    label: 'Reset layout',
    tilingOnly: true,
    hotkeyOptions: { preventDefault: true },
  },
  search: {
    keys: 'mod+k',
    label: 'Search messages',
    hotkeyOptions: { preventDefault: true, enableOnFormTags: true },
  },
  'show-shortcuts': {
    keys: 'shift+/',
    label: 'Show this help',
    hotkeyOptions: { preventDefault: true, enableOnFormTags: false },
  },
} as const satisfies Record<string, Keybind>;

export type KeybindId = keyof typeof KEYBINDS;

const IS_MAC =
  typeof navigator !== 'undefined' &&
  /Mac|iPhone|iPad/.test(navigator.userAgent);

function formatDisplayKeys(keys: string): string {
  return keys
    .split('+')
    .map((k) => {
      if (k === 'mod') return IS_MAC ? 'Cmd' : 'Ctrl';
      if (k === 'left') return '\u2190';
      if (k === 'right') return '\u2192';
      if (k === 'up') return '\u2191';
      if (k === 'down') return '\u2193';
      if (k === '/') return '?';
      return k.charAt(0).toUpperCase() + k.slice(1);
    })
    .join('+');
}

/** Get display-friendly key string for a keybind. */
export function getDisplayKeys(id: KeybindId): string {
  return formatDisplayKeys(KEYBINDS[id].keys);
}

function isFormElement(target: EventTarget | null): boolean {
  if (!target || !(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    target.isContentEditable
  );
}

const KEY_MAP: Record<string, string> = {
  left: 'arrowleft',
  right: 'arrowright',
  up: 'arrowup',
  down: 'arrowdown',
  tab: 'tab',
  '/': '/',
};

/** Match a KeyboardEvent against a hotkey string like 'ctrl+shift+v' or 'mod+k'. */
export function matchesKeybind(e: KeyboardEvent, keys: string): boolean {
  const parts = keys.toLowerCase().split('+');
  const key = parts[parts.length - 1];
  const modifiers = new Set(parts.slice(0, -1));

  const needsCtrl = modifiers.has('ctrl') || (!IS_MAC && modifiers.has('mod'));
  const needsMeta = IS_MAC && modifiers.has('mod');
  const needsShift = modifiers.has('shift');
  const needsAlt = modifiers.has('alt');

  if (needsCtrl !== e.ctrlKey) return false;
  if (needsMeta !== e.metaKey) return false;
  if (needsShift !== e.shiftKey) return false;
  if (needsAlt !== e.altKey) return false;

  const eventKey = e.key.toLowerCase();
  const expected = KEY_MAP[key] ?? key;
  return eventKey === expected;
}

/** Check whether a keyboard event should be suppressed based on keybind options and focus target. */
export function shouldSuppressKeybind(
  e: KeyboardEvent,
  keybind: Keybind,
): boolean {
  const enableOnFormTags = keybind.hotkeyOptions?.enableOnFormTags;
  // Default: suppress in form elements (same as react-hotkeys-hook default)
  if (enableOnFormTags !== true && isFormElement(e.target)) return true;
  return false;
}
