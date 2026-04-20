// Owns OS-level global keybind capture for the desktop app.
//
// IPC contract (renderer → main):
//   keybinds:sync(SyncedBinding[])      → { status: Record<KeybindId, Status> }
//   keybinds:enableHoldGlobals()        → { ok: boolean; reason?: string }
// IPC events (main → renderer):
//   keybind:fire { id: KeybindId; phase: 'press' | 'release' }
//
// Trust boundary:
//   - Every handler refuses senders other than mainWindow.webContents.id.
//   - Every payload is schema-validated before reaching globalShortcut.register.
//   - Hold-type listener (uiohook-napi) is gated behind an explicit opt-in IPC
//     and a persisted electron-store bit; never started by keybinds:sync alone.
//
// Multi-window: this module captures a single mainWindow reference. If a
// future feature adds secondary windows that need keybinds, refactor to a
// window registry rather than expanding the captured reference.

import type {
  KeybindGlobalStatus,
  KeybindId,
  SyncedBinding,
} from '@meza/core/keybinds';
import {
  type BrowserWindow,
  globalShortcut,
  type IpcMainInvokeEvent,
  ipcMain,
  systemPreferences,
} from 'electron';
import { toElectronAccelerator } from './accelerator.js';
import { isWayland } from './platform.js';
import { store } from './store.js';
import { validatePayload } from './validatePayload.js';

const SYNC_DEBOUNCE_MS = 50;

const status = new Map<KeybindId, KeybindGlobalStatus>();
const registered = new Set<string>(); // accelerators currently held

let win: BrowserWindow | null = null;
let syncInFlight: Promise<void> = Promise.resolve();
let syncDebounce: ReturnType<typeof setTimeout> | null = null;

// ── outbound IPC ─────────────────────────────────────────────────────────

function send(payload: { id: KeybindId; phase: 'press' | 'release' }) {
  if (!win || win.isDestroyed()) return;
  if (win.webContents.isDestroyed()) return;
  win.webContents.send('keybind:fire', payload);
}

// ── public API ───────────────────────────────────────────────────────────

export function registerKeybindHandlers(window: BrowserWindow): void {
  win = window;

  ipcMain.handle('keybinds:sync', (e: IpcMainInvokeEvent, payload: unknown) => {
    if (!win || e.sender.id !== win.webContents.id) {
      return { status: {} as Record<KeybindId, KeybindGlobalStatus> };
    }
    const bindings = validatePayload(payload);
    if (!bindings) {
      return { status: {} as Record<KeybindId, KeybindGlobalStatus> };
    }
    return scheduleSync(bindings);
  });

  ipcMain.handle(
    'keybinds:enableHoldGlobals',
    async (e: IpcMainInvokeEvent) => {
      if (!win || e.sender.id !== win.webContents.id) {
        return { ok: false, reason: 'unsupported' as const };
      }
      return enableHoldGlobals();
    },
  );
}

export function disposeAll(): void {
  if (syncDebounce) {
    clearTimeout(syncDebounce);
    syncDebounce = null;
  }
  globalShortcut.unregisterAll();
  registered.clear();
  status.clear();
  teardownHoldListener();
  win = null;
}

// ── sync scheduling (debounced + serialised) ─────────────────────────────

function scheduleSync(
  bindings: SyncedBinding[],
): Promise<{ status: Record<KeybindId, KeybindGlobalStatus> }> {
  if (syncDebounce) clearTimeout(syncDebounce);
  return new Promise((resolve) => {
    syncDebounce = setTimeout(() => {
      syncDebounce = null;
      syncInFlight = syncInFlight.then(() => doSync(bindings));
      syncInFlight.then(() => {
        resolve({
          status: Object.fromEntries(status) as Record<
            KeybindId,
            KeybindGlobalStatus
          >,
        });
      });
    }, SYNC_DEBOUNCE_MS);
  });
}

async function doSync(bindings: SyncedBinding[]): Promise<void> {
  // Forget status entries for any binding no longer in the payload, so the
  // returned status map only describes the current state.
  const incomingIds = new Set(bindings.map((b) => b.id));
  for (const id of [...status.keys()]) {
    if (!incomingIds.has(id)) status.delete(id);
  }

  // Press: globalShortcut, idempotent diff. Reject duplicate accelerators
  // within a single payload so a compromised renderer can't bypass the
  // recorder UI's conflict check.
  const wantedPress = new Map<string, SyncedBinding>();
  const seenAccel = new Set<string>();
  for (const b of bindings) {
    if (!b.isGlobal) continue;
    if (b.type !== 'press') continue;
    const accel = toElectronAccelerator(b.keys);
    if (!accel) {
      status.set(b.id, 'unsupported');
      continue;
    }
    if (seenAccel.has(accel)) {
      status.set(b.id, 'failed');
      continue;
    }
    seenAccel.add(accel);
    wantedPress.set(accel, b);
  }

  // Snapshot before iteration — never mutate a Set during for-of.
  for (const accel of [...registered]) {
    if (!wantedPress.has(accel)) {
      globalShortcut.unregister(accel);
      registered.delete(accel);
    }
  }
  for (const [accel, b] of wantedPress) {
    if (registered.has(accel)) {
      // Already registered with this accelerator. Re-bind status anyway in
      // case the previous owner of the accelerator was a different binding
      // that has since been unbound.
      status.set(b.id, 'active');
      continue;
    }
    const ok = globalShortcut.register(accel, () =>
      send({ id: b.id, phase: 'press' }),
    );
    status.set(b.id, ok ? 'active' : 'failed');
    if (ok) registered.add(accel);
  }

  await ensureHoldListener(
    bindings.filter((b) => b.isGlobal && b.type === 'hold'),
  );
}

// ── hold listener (Phase 2 — uiohook-napi) ───────────────────────────────
//
// INVARIANT: uiohook event objects MUST NOT be logged, serialised, or
// forwarded over IPC. Only matched `{ id, phase }` payloads cross the
// boundary. The raw `e` is read only inside the closures below.
//
// Listener gating:
//   1. Wayland short-circuits — uiohook uses X11/evdev, doesn't work.
//   2. The user must have called keybinds:enableHoldGlobals (which writes
//      keybinds.holdGlobalsOptIn=true); a sync alone never starts it.
//   3. On macOS, Accessibility must be granted.

type HoldState = 'idle' | 'starting' | 'active' | 'stopping';
let holdState: HoldState = 'idle';
let holdBindingsCache: SyncedBinding[] = [];
const activeHolds = new Set<KeybindId>(); // bindings whose press has fired

// Reverse lookup from uiohook keycode → our hotkey-format primary-key string.
// Built lazily on first listener init so we don't pay for the import unless
// the user enables hold globals.
let keycodeToName: Map<number, string> | null = null;
const MODIFIER_KEYCODES = new Set<number>();

async function ensureHoldListener(
  holdBindings: SyncedBinding[],
): Promise<void> {
  holdBindingsCache = holdBindings;

  if (holdBindings.length === 0) {
    if (holdState === 'active') teardownHoldListener();
    return;
  }

  if (isWayland()) {
    for (const b of holdBindings) status.set(b.id, 'unsupported');
    return;
  }

  if (!store.get('keybinds.holdGlobalsOptIn')) {
    for (const b of holdBindings) status.set(b.id, 'permission');
    return;
  }

  if (
    process.platform === 'darwin' &&
    !systemPreferences.isTrustedAccessibilityClient(false)
  ) {
    for (const b of holdBindings) status.set(b.id, 'permission');
    return;
  }

  if (holdState === 'active' || holdState === 'starting') {
    for (const b of holdBindings) status.set(b.id, 'active');
    return;
  }

  holdState = 'starting';
  try {
    const { uIOhook, UiohookKey } = await import('uiohook-napi');
    if (!keycodeToName) {
      keycodeToName = new Map();
      for (const [name, code] of Object.entries(UiohookKey)) {
        if (typeof code === 'number') {
          keycodeToName.set(code, normaliseKeyName(name));
        }
      }
      MODIFIER_KEYCODES.add(UiohookKey.Ctrl);
      MODIFIER_KEYCODES.add(UiohookKey.CtrlRight);
      MODIFIER_KEYCODES.add(UiohookKey.Shift);
      MODIFIER_KEYCODES.add(UiohookKey.ShiftRight);
      MODIFIER_KEYCODES.add(UiohookKey.Alt);
      MODIFIER_KEYCODES.add(UiohookKey.AltRight);
      MODIFIER_KEYCODES.add(UiohookKey.Meta);
      MODIFIER_KEYCODES.add(UiohookKey.MetaRight);
    }

    uIOhook.on('keydown', onUiohookKeyDown);
    uIOhook.on('keyup', onUiohookKeyUp);
    uIOhook.start();
    holdState = 'active';
    for (const b of holdBindings) status.set(b.id, 'active');
  } catch (err) {
    console.error('[keybinds] failed to start uiohook:', err);
    holdState = 'idle';
    for (const b of holdBindings) status.set(b.id, 'unsupported');
  }
}

function teardownHoldListener(): void {
  if (holdState !== 'active' && holdState !== 'starting') {
    holdBindingsCache = [];
    activeHolds.clear();
    return;
  }
  holdState = 'stopping';
  try {
    // Cheap dynamic require of the already-loaded module.
    import('uiohook-napi')
      .then(({ uIOhook }) => {
        uIOhook.off('keydown', onUiohookKeyDown);
        uIOhook.off('keyup', onUiohookKeyUp);
        uIOhook.stop();
      })
      .catch(() => {});
  } finally {
    holdBindingsCache = [];
    activeHolds.clear();
    holdState = 'idle';
  }
}

function onUiohookKeyDown(e: {
  keycode: number;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}): void {
  if (MODIFIER_KEYCODES.has(e.keycode)) return;
  const primary = keycodeToName?.get(e.keycode);
  if (!primary) return;

  for (const b of holdBindingsCache) {
    if (activeHolds.has(b.id)) continue;
    if (!matchesUiohookEvent(b.keys, primary, e)) continue;
    activeHolds.add(b.id);
    send({ id: b.id, phase: 'press' });
  }
}

function onUiohookKeyUp(e: { keycode: number }): void {
  if (activeHolds.size === 0) return;
  if (MODIFIER_KEYCODES.has(e.keycode)) return;
  const primary = keycodeToName?.get(e.keycode);
  if (!primary) return;

  for (const b of holdBindingsCache) {
    if (!activeHolds.has(b.id)) continue;
    const parts = b.keys.toLowerCase().split('+');
    if (parts[parts.length - 1] === primary) {
      activeHolds.delete(b.id);
      send({ id: b.id, phase: 'release' });
    }
  }
}

function matchesUiohookEvent(
  keys: string,
  primary: string,
  e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean },
): boolean {
  const parts = keys.toLowerCase().split('+');
  const expectedPrimary = parts[parts.length - 1];
  if (expectedPrimary !== primary) return false;
  const mods = new Set(parts.slice(0, -1));
  // 'mod' translates to ctrl on win/linux, meta on mac.
  const needsCtrl =
    mods.has('ctrl') || (process.platform !== 'darwin' && mods.has('mod'));
  const needsMeta =
    mods.has('meta') || (process.platform === 'darwin' && mods.has('mod'));
  if (needsCtrl !== e.ctrlKey) return false;
  if (needsMeta !== e.metaKey) return false;
  if (mods.has('shift') !== e.shiftKey) return false;
  if (mods.has('alt') !== e.altKey) return false;
  return true;
}

/** Normalise a UiohookKey enum name to our hotkey-format primary-key string. */
function normaliseKeyName(name: string): string {
  const lower = name.toLowerCase();
  if (lower === 'arrowleft') return 'left';
  if (lower === 'arrowright') return 'right';
  if (lower === 'arrowup') return 'up';
  if (lower === 'arrowdown') return 'down';
  if (lower === 'semicolon') return ';';
  if (lower === 'equal') return '=';
  if (lower === 'comma') return ',';
  if (lower === 'minus') return '-';
  if (lower === 'period') return '.';
  if (lower === 'slash') return '/';
  if (lower === 'backquote') return '`';
  if (lower === 'bracketleft') return '[';
  if (lower === 'backslash') return '\\';
  if (lower === 'bracketright') return ']';
  if (lower === 'quote') return "'";
  return lower;
}

async function enableHoldGlobals(): Promise<{
  ok: boolean;
  reason?: 'permission' | 'wayland' | 'unsupported';
}> {
  if (isWayland()) return { ok: false, reason: 'wayland' };

  if (process.platform === 'darwin') {
    // Pass `true` to surface the macOS Accessibility prompt. This is the
    // ONLY callsite that may surface that prompt — it is gated behind the
    // explicit user opt-in IPC.
    if (!systemPreferences.isTrustedAccessibilityClient(true)) {
      return { ok: false, reason: 'permission' };
    }
  }

  store.set('keybinds.holdGlobalsOptIn', true);

  // If a hold sync is already pending, kick the listener now.
  if (holdBindingsCache.length > 0 && holdState === 'idle') {
    await ensureHoldListener(holdBindingsCache);
  }
  return { ok: true };
}
