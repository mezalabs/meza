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
  powerMonitor,
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
      return { status: {} as Partial<Record<KeybindId, KeybindGlobalStatus>> };
    }
    const bindings = validatePayload(payload);
    if (!bindings) {
      return { status: {} as Partial<Record<KeybindId, KeybindGlobalStatus>> };
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
): Promise<{ status: Partial<Record<KeybindId, KeybindGlobalStatus>> }> {
  if (syncDebounce) clearTimeout(syncDebounce);
  return new Promise((resolve) => {
    syncDebounce = setTimeout(() => {
      syncDebounce = null;
      // Catch rejections at every level: a single doSync error must not
      // poison `syncInFlight` (which would silently hang every future sync)
      // and must not skip the resolve() (which would hang the renderer's
      // Promise from `electronAPI.keybinds.sync`).
      syncInFlight = syncInFlight
        .then(() => doSync(bindings))
        .catch((err) => {
          console.error('[keybinds] doSync failed:', err);
        });
      syncInFlight.finally(() => {
        resolve({
          status: Object.fromEntries(status) as Partial<
            Record<KeybindId, KeybindGlobalStatus>
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

// Lifecycle: a single in-flight start-or-stop op serialises everything.
// Concurrent ensureHoldListener / teardownHoldListener calls await the
// previous op before deciding what to do. This prevents the duplicate
// native callback / X11 grab leak that arises when stop() is called
// synchronously while the previous start()'s dynamic import is still
// resolving.
let holdActive = false;
let holdOpInFlight: Promise<void> | null = null;
let holdBindingsCache: SyncedBinding[] = [];
const activeHolds = new Set<KeybindId>(); // bindings whose press has fired
let uIOhookCached: typeof import('uiohook-napi') | null = null;

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
    await stopHold();
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

  // Re-check Accessibility on every active sync; the user can revoke at
  // any time and we want the next sync to downgrade status accordingly.
  if (
    process.platform === 'darwin' &&
    !systemPreferences.isTrustedAccessibilityClient(false)
  ) {
    if (holdActive) await stopHold();
    for (const b of holdBindings) status.set(b.id, 'permission');
    return;
  }

  // Drain any in-flight op (start or stop) before deciding.
  if (holdOpInFlight) {
    await holdOpInFlight.catch(() => {});
  }

  if (holdActive) {
    for (const b of holdBindings) status.set(b.id, 'active');
    return;
  }

  await startHold(holdBindings);
}

function buildKeycodeMap(UiohookKey: typeof import('uiohook-napi').UiohookKey) {
  if (keycodeToName) return;
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

async function startHold(holdBindings: SyncedBinding[]): Promise<void> {
  holdOpInFlight = (async () => {
    try {
      if (!uIOhookCached) uIOhookCached = await import('uiohook-napi');
      const { uIOhook, UiohookKey } = uIOhookCached;
      buildKeycodeMap(UiohookKey);
      setupPowerMonitorOnce();
      uIOhook.on('keydown', onUiohookKeyDown);
      uIOhook.on('keyup', onUiohookKeyUp);
      uIOhook.start();
      holdActive = true;
      for (const b of holdBindings) status.set(b.id, 'active');
    } catch (err) {
      console.error('[keybinds] failed to start uiohook:', err);
      for (const b of holdBindings) status.set(b.id, 'unsupported');
    }
  })();
  try {
    await holdOpInFlight;
  } finally {
    holdOpInFlight = null;
  }
}

async function stopHold(): Promise<void> {
  // Drain any in-flight start before stopping; otherwise we race the
  // start() that's mid-resolve.
  if (holdOpInFlight) {
    await holdOpInFlight.catch(() => {});
  }
  if (!holdActive) {
    activeHolds.clear();
    return;
  }
  holdOpInFlight = (async () => {
    if (!uIOhookCached) return;
    const { uIOhook } = uIOhookCached;
    try {
      uIOhook.off('keydown', onUiohookKeyDown);
      uIOhook.off('keyup', onUiohookKeyUp);
      uIOhook.stop();
    } catch (err) {
      console.error('[keybinds] uiohook stop failed:', err);
    } finally {
      holdActive = false;
      activeHolds.clear();
    }
  })();
  try {
    await holdOpInFlight;
  } finally {
    holdOpInFlight = null;
  }
}

/**
 * Best-effort sync entry point used from disposeAll. Schedules a stop
 * but does not wait — disposeAll is called from process signal handlers
 * where awaiting is not reliable. The OS reaps any leftover hook on
 * process exit anyway.
 */
function teardownHoldListener(): void {
  void stopHold();
  holdBindingsCache = [];
  clearAllWatchdogs();
}

// ── stuck-hold protection ──────────────────────────────────────────────
//
// A hold binding stays "pressed" until the OS delivers a matching keyup.
// The OS swallows keyups when: the screen locks mid-press, the system
// suspends, or another window's modal swallows the event. A stuck hold
// on push-to-mute leaves the user's mic open in voice — a privacy bug.
//
// Two safeguards: powerMonitor events for the predictable cases, and a
// per-binding watchdog as a worst-case ceiling.

const HOLD_WATCHDOG_MS = 30_000;
const watchdogs = new Map<KeybindId, ReturnType<typeof setTimeout>>();
let powerMonitorWired = false;

function armWatchdog(id: KeybindId) {
  clearWatchdog(id);
  watchdogs.set(
    id,
    setTimeout(() => {
      if (activeHolds.has(id)) {
        activeHolds.delete(id);
        send({ id, phase: 'release' });
      }
      watchdogs.delete(id);
    }, HOLD_WATCHDOG_MS),
  );
}

function clearWatchdog(id: KeybindId) {
  const t = watchdogs.get(id);
  if (t) {
    clearTimeout(t);
    watchdogs.delete(id);
  }
}

function clearAllWatchdogs() {
  for (const t of watchdogs.values()) clearTimeout(t);
  watchdogs.clear();
}

function releaseAllHolds() {
  for (const id of [...activeHolds]) {
    activeHolds.delete(id);
    clearWatchdog(id);
    send({ id, phase: 'release' });
  }
}

function setupPowerMonitorOnce() {
  if (powerMonitorWired) return;
  powerMonitorWired = true;
  // 'suspend' fires on system sleep; 'lock-screen' on screen lock (macOS,
  // Windows). Either can swallow the keyup that would normally end a
  // press-and-hold. Synthesise releases so the renderer doesn't leave
  // the user muted/unmuted incorrectly.
  powerMonitor.on('suspend', releaseAllHolds);
  powerMonitor.on('lock-screen', releaseAllHolds);
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
    armWatchdog(b.id);
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
      clearWatchdog(b.id);
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
