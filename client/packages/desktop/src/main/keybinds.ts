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

import {
  type BrowserWindow,
  globalShortcut,
  type IpcMainInvokeEvent,
  ipcMain,
} from 'electron';
import {
  KEYBINDS,
  type KeybindGlobalStatus,
  type KeybindId,
  type SyncedBinding,
} from '@meza/core/keybinds';
import { toElectronAccelerator } from './accelerator.js';

const VALID_IDS = new Set<string>(Object.keys(KEYBINDS));
const MAX_BINDINGS = 32;
const MAX_KEYS_LEN = 32;
const SYNC_DEBOUNCE_MS = 50;

const status = new Map<KeybindId, KeybindGlobalStatus>();
const registered = new Set<string>(); // accelerators currently held

let win: BrowserWindow | null = null;
let syncInFlight: Promise<void> = Promise.resolve();
let syncDebounce: ReturnType<typeof setTimeout> | null = null;

// ── validation ───────────────────────────────────────────────────────────

function validatePayload(p: unknown): SyncedBinding[] | null {
  if (!Array.isArray(p)) return null;
  if (p.length > MAX_BINDINGS) return null;
  const out: SyncedBinding[] = [];
  for (const item of p) {
    if (typeof item !== 'object' || item === null) return null;
    const obj = item as Record<string, unknown>;
    const { id, keys, type, isGlobal } = obj;
    if (typeof id !== 'string' || !VALID_IDS.has(id)) return null;
    if (typeof keys !== 'string' || keys.length > MAX_KEYS_LEN) return null;
    if (type !== 'press' && type !== 'hold') return null;
    if (typeof isGlobal !== 'boolean') return null;
    out.push({ id: id as KeybindId, keys, type, isGlobal });
  }
  return out;
}

// ── outbound IPC ─────────────────────────────────────────────────────────

function send(payload: { id: KeybindId; phase: 'press' | 'release' }) {
  if (!win || win.isDestroyed()) return;
  if (win.webContents.isDestroyed()) return;
  win.webContents.send('keybind:fire', payload);
}

// ── public API ───────────────────────────────────────────────────────────

export function registerKeybindHandlers(window: BrowserWindow): void {
  win = window;

  ipcMain.handle(
    'keybinds:sync',
    (e: IpcMainInvokeEvent, payload: unknown) => {
      if (!win || e.sender.id !== win.webContents.id) {
        return { status: {} as Record<KeybindId, KeybindGlobalStatus> };
      }
      const bindings = validatePayload(payload);
      if (!bindings) {
        return { status: {} as Record<KeybindId, KeybindGlobalStatus> };
      }
      return scheduleSync(bindings);
    },
  );

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

// ── hold listener (Phase 2) ──────────────────────────────────────────────
// Stubs for now — enabled in a follow-up commit when uiohook-napi lands.

async function ensureHoldListener(holdBindings: SyncedBinding[]): Promise<void> {
  // For now, mark every requested hold-global as unsupported until Phase 2
  // wires up uiohook-napi.
  for (const b of holdBindings) {
    status.set(b.id, 'unsupported');
  }
}

function teardownHoldListener(): void {
  // Phase 2 will stop uIOhook here.
}

async function enableHoldGlobals(): Promise<{
  ok: boolean;
  reason?: 'permission' | 'wayland' | 'unsupported';
}> {
  // Phase 2 implements the real opt-in flow.
  return { ok: false, reason: 'unsupported' };
}
