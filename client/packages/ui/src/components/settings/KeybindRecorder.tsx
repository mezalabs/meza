import {
  displayKeysFor,
  isElectron,
  KEYBINDS,
  type KeybindId,
  useKeybindOverridesStore,
} from '@meza/core';
import { useCallback, useEffect, useRef, useState } from 'react';

/** Keys that cannot be captured in a browser (they're intercepted by the browser). */
const BROWSER_RESERVED: Set<string> = new Set([
  'ctrl+w',
  'ctrl+t',
  'ctrl+n',
  'ctrl+shift+n',
  'ctrl+shift+t',
  'ctrl+tab',
  'ctrl+shift+tab',
  'ctrl+l',
  'ctrl+shift+i',
  'ctrl+shift+j',
  'ctrl+shift+c',
  'f11',
  'f12',
]);

/** Modifier-only keys that should not count as a binding. */
const MODIFIER_KEYS = new Set(['shift', 'control', 'alt', 'meta', 'os']);

function keyEventToString(e: KeyboardEvent): string | null {
  const key = e.key.toLowerCase();
  if (MODIFIER_KEYS.has(key)) return null;

  const parts: string[] = [];
  if (e.ctrlKey) parts.push('ctrl');
  if (e.metaKey) parts.push('meta');
  if (e.altKey) parts.push('alt');
  if (e.shiftKey) parts.push('shift');

  // Normalize special keys
  const keyMap: Record<string, string> = {
    arrowleft: 'left',
    arrowright: 'right',
    arrowup: 'up',
    arrowdown: 'down',
    ' ': 'space',
  };
  parts.push(keyMap[key] ?? key);
  return parts.join('+');
}

interface KeybindRecorderProps {
  keybindId: KeybindId;
  currentKeys: string;
  onDone: () => void;
}

export function KeybindRecorder({
  keybindId,
  currentKeys,
  onDone,
}: KeybindRecorderProps) {
  const [recording, setRecording] = useState(false);
  const [captured, setCaptured] = useState<string | null>(null);
  const conflicts = captured
    ? useKeybindOverridesStore.getState().getConflicts(captured, keybindId)
    : [];
  const containerRef = useRef<HTMLDivElement>(null);

  const startRecording = useCallback(() => {
    setRecording(true);
    setCaptured(null);
  }, []);

  useEffect(() => {
    if (!recording) return;

    function handler(e: KeyboardEvent) {
      e.preventDefault();
      e.stopPropagation();

      // Escape cancels recording
      if (e.key === 'Escape') {
        setRecording(false);
        setCaptured(null);
        return;
      }

      const combo = keyEventToString(e);
      if (!combo) return; // Modifier-only press

      setCaptured(combo);
      setRecording(false);
    }

    document.addEventListener('keydown', handler, { capture: true });
    return () =>
      document.removeEventListener('keydown', handler, { capture: true });
  }, [recording]);

  const save = () => {
    if (captured) {
      useKeybindOverridesStore.getState().setOverride(keybindId, captured);
    }
    setCaptured(null);
    onDone();
  };

  const cancel = () => {
    setCaptured(null);
    setRecording(false);
    onDone();
  };

  const isBrowserReserved =
    captured && !isElectron() && BROWSER_RESERVED.has(captured.toLowerCase());

  if (recording) {
    return (
      <div ref={containerRef} className="flex items-center gap-2">
        <kbd className="rounded-md bg-accent/20 px-3 py-1 font-mono text-xs text-accent animate-pulse">
          Press a key...
        </kbd>
        <button
          type="button"
          onClick={cancel}
          className="text-xs text-text-subtle hover:text-text"
        >
          Cancel
        </button>
      </div>
    );
  }

  if (captured) {
    return (
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <kbd className="rounded-md bg-bg-surface px-2 py-0.5 font-mono text-xs text-text-subtle">
            {displayKeysFor(captured)}
          </kbd>
          <button
            type="button"
            onClick={save}
            className="rounded px-2 py-0.5 text-xs font-medium bg-accent text-black hover:bg-accent-hover"
          >
            Save
          </button>
          <button
            type="button"
            onClick={cancel}
            className="text-xs text-text-subtle hover:text-text"
          >
            Cancel
          </button>
        </div>
        {isBrowserReserved && (
          <span className="text-xs text-warning">
            Reserved by browser — may not work in the web client.
          </span>
        )}
        {conflicts.length > 0 && (
          <span className="text-xs text-warning">
            Conflicts with:{' '}
            {conflicts.map((id) => KEYBINDS[id].label).join(', ')}
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <kbd
        className={`rounded-md px-2 py-0.5 font-mono text-xs ${
          currentKeys
            ? 'bg-bg-surface text-text-subtle'
            : 'text-text-subtle italic'
        }`}
      >
        {currentKeys ? displayKeysFor(currentKeys) : 'Not set'}
      </kbd>
      <button
        type="button"
        onClick={startRecording}
        className="rounded px-2 py-0.5 text-xs text-text-subtle hover:bg-bg-surface hover:text-text"
      >
        Edit
      </button>
    </div>
  );
}
