export type KeybindCategory = 'navigation' | 'tiling' | 'voice' | 'channels';

export interface Keybind {
  /** Key combo in hotkey format: 'ctrl+shift+v', 'mod+k'. Empty string = unbound. */
  keys: string;
  /** Short label for the help overlay */
  label: string;
  /** 'press' (default) fires on keydown, 'hold' fires on keydown and releases on keyup */
  type?: 'press' | 'hold';
  /** Category for grouping in the settings UI */
  category?: KeybindCategory;
  /** Hidden in simple mode (single-pane layout) */
  tilingOnly?: boolean;
  /** Only fires when connected to a voice channel */
  voiceOnly?: boolean;
  /**
   * Whether this binding can be promoted to an OS-level global hotkey
   * (captured even when the app is unfocused). Default: !tilingOnly.
   * Set explicitly to false for in-app-only bindings like `show-shortcuts`.
   */
  globalEligible?: boolean;
  /** Options passed to the key event handler */
  hotkeyOptions?: {
    /** Fire even when a form element (input/textarea/select) is focused */
    enableOnFormTags?: boolean;
    /** Call e.preventDefault() on match (default: true) */
    preventDefault?: boolean;
  };
}

/** Status of a globally-registered keybind, surfaced in the settings UI. */
export type KeybindGlobalStatus =
  | 'active'
  | 'failed'
  | 'unsupported'
  | 'permission';

/**
 * IPC payload shape: a snapshot of the bindings the renderer wants the main
 * process to register/listen for. Validated at the IPC boundary in main.
 */
export interface SyncedBinding {
  id: KeybindId;
  keys: string;
  type: 'press' | 'hold';
  isGlobal: boolean;
}

export const KEYBINDS = {
  // --- Tiling ---
  'split-horizontal': {
    keys: 'ctrl+shift+v',
    label: 'Split right',
    category: 'tiling',
    tilingOnly: true,
    hotkeyOptions: { preventDefault: true },
  },
  'split-vertical': {
    keys: 'ctrl+shift+h',
    label: 'Split down',
    category: 'tiling',
    tilingOnly: true,
    hotkeyOptions: { preventDefault: true },
  },
  'close-pane': {
    keys: 'ctrl+shift+w',
    label: 'Close pane',
    category: 'tiling',
    tilingOnly: true,
    hotkeyOptions: { preventDefault: true },
  },
  'move-focus-left': {
    keys: 'ctrl+shift+left',
    label: 'Move focus left',
    category: 'tiling',
    tilingOnly: true,
    hotkeyOptions: { preventDefault: true },
  },
  'move-focus-right': {
    keys: 'ctrl+shift+right',
    label: 'Move focus right',
    category: 'tiling',
    tilingOnly: true,
    hotkeyOptions: { preventDefault: true },
  },
  'move-focus-up': {
    keys: 'ctrl+shift+up',
    label: 'Move focus up',
    category: 'tiling',
    tilingOnly: true,
    hotkeyOptions: { preventDefault: true },
  },
  'move-focus-down': {
    keys: 'ctrl+shift+down',
    label: 'Move focus down',
    category: 'tiling',
    tilingOnly: true,
    hotkeyOptions: { preventDefault: true },
  },
  'cycle-focus': {
    keys: 'ctrl+shift+tab',
    label: 'Cycle focus',
    category: 'tiling',
    tilingOnly: true,
    hotkeyOptions: { preventDefault: true },
  },
  'reset-layout': {
    keys: 'ctrl+shift+e',
    label: 'Reset layout',
    category: 'tiling',
    tilingOnly: true,
    hotkeyOptions: { preventDefault: true },
  },
  // --- Navigation ---
  search: {
    keys: 'mod+k',
    label: 'Search messages',
    category: 'navigation',
    hotkeyOptions: { preventDefault: true, enableOnFormTags: true },
  },
  'show-shortcuts': {
    keys: 'shift+/',
    label: 'Show this help',
    category: 'navigation',
    globalEligible: false,
    hotkeyOptions: { preventDefault: true, enableOnFormTags: false },
  },
  // --- Voice ---
  'toggle-mute': {
    keys: 'ctrl+shift+m',
    label: 'Toggle mute',
    category: 'voice',
    voiceOnly: true,
    hotkeyOptions: { enableOnFormTags: true, preventDefault: true },
  },
  'toggle-deafen': {
    keys: 'ctrl+shift+d',
    label: 'Toggle deafen',
    category: 'voice',
    voiceOnly: true,
    hotkeyOptions: { enableOnFormTags: true, preventDefault: true },
  },
  'push-to-mute': {
    keys: '',
    label: 'Push-to-mute',
    type: 'hold',
    category: 'voice',
    voiceOnly: true,
    hotkeyOptions: { enableOnFormTags: true, preventDefault: true },
  },
  'push-to-deafen': {
    keys: '',
    label: 'Push-to-deafen',
    type: 'hold',
    category: 'voice',
    voiceOnly: true,
    hotkeyOptions: { enableOnFormTags: true, preventDefault: true },
  },
  // --- Channels ---
  'mark-channel-read': {
    keys: 'escape',
    label: 'Mark channel read',
    category: 'channels',
    hotkeyOptions: { preventDefault: false },
  },
  'mark-server-read': {
    keys: 'shift+escape',
    label: 'Mark server read',
    category: 'channels',
    hotkeyOptions: { preventDefault: true },
  },
} as const satisfies Record<string, Keybind>;

export type KeybindId = keyof typeof KEYBINDS;

const IS_MAC =
  typeof navigator !== 'undefined' &&
  /Mac|iPhone|iPad/.test(navigator.userAgent);

/** Format a hotkey string into a display-friendly format. */
export function formatDisplayKeys(keys: string): string {
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

/** Get display-friendly key string for a keybind using its default keys. */
export function getDisplayKeys(id: KeybindId): string {
  return formatDisplayKeys(KEYBINDS[id].keys);
}

/** Get display-friendly key string for an arbitrary hotkey string. */
export function displayKeysFor(keys: string): string {
  return keys ? formatDisplayKeys(keys) : '';
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
  escape: 'escape',
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

/**
 * Whether a keybind can be promoted to an OS-level global hotkey. Defaults
 * derive from existing flags (tiling bindings are never useful out-of-app),
 * with explicit `globalEligible: false` overriding for in-app-only bindings.
 */
export function isGlobalEligible(id: KeybindId): boolean {
  const def: Keybind = KEYBINDS[id];
  if (def.globalEligible !== undefined) return def.globalEligible;
  return !def.tilingOnly;
}
