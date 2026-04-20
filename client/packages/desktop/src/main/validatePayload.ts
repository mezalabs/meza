// Schema-validates the `keybinds:sync` IPC payload before it reaches the
// main-process state machine. Lives in its own file so it has zero
// `electron` import, which lets the test suite import it directly.
//
// Every branch here is a place a malicious or buggy renderer could try to
// abuse the global hotkey surface. Tests in validatePayload.test.ts must
// cover every rejection case.

import { KEYBINDS, type SyncedBinding } from '@meza/core/keybinds';

export const MAX_BINDINGS = 32;
export const MAX_KEYS_LEN = 32;

const VALID_IDS = new Set<string>(Object.keys(KEYBINDS));

export function validatePayload(p: unknown): SyncedBinding[] | null {
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
    out.push({ id: id as SyncedBinding['id'], keys, type, isGlobal });
  }
  return out;
}
