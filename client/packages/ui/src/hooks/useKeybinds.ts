import {
  ackMessage,
  type ElectronKeybindGlobalStatus,
  isGlobalEligible,
  KEYBINDS,
  type Keybind,
  type KeybindId,
  type KeybindSyncedBinding,
  matchesKeybind,
  shouldSuppressKeybind,
  soundManager,
  useChannelStore,
  useKeybindGlobalStatusStore,
  useKeybindOverridesStore,
  useMessageStore,
  useNotificationSettingsStore,
  useReadStateStore,
  useVoiceStore,
} from '@meza/core';
import { useEffect, useMemo, useRef } from 'react';
import { useNavigationStore } from '../stores/navigation.ts';
import { openSearchPane, useTilingStore } from '../stores/tiling.ts';
import { toggleDeafen, toggleMute } from '../utils/voiceControls.ts';

interface UseKeybindsOptions {
  onShowShortcuts: () => void;
}

type PressAction = () => void;
interface HoldAction {
  onPress: () => void;
  onRelease: () => void;
}

export function useKeybinds({ onShowShortcuts }: UseKeybindsOptions) {
  const pressActions = useMemo<Partial<Record<KeybindId, PressAction>>>(
    () => ({
      // --- Tiling ---
      'split-horizontal': () =>
        useTilingStore.getState().splitFocused('horizontal'),
      'split-vertical': () =>
        useTilingStore.getState().splitFocused('vertical'),
      'close-pane': () => useTilingStore.getState().closeFocused(),
      'move-focus-left': () => useTilingStore.getState().moveFocus('left'),
      'move-focus-right': () => useTilingStore.getState().moveFocus('right'),
      'move-focus-up': () => useTilingStore.getState().moveFocus('up'),
      'move-focus-down': () => useTilingStore.getState().moveFocus('down'),
      'cycle-focus': () => useTilingStore.getState().cycleFocus(),
      'reset-layout': () => useTilingStore.getState().resetLayout(),
      // --- Navigation ---
      search: () => openSearchPane(),
      'show-shortcuts': onShowShortcuts,
      // --- Voice ---
      'toggle-mute': () => {
        if (useVoiceStore.getState().status !== 'connected') return;
        const newEnabled = toggleMute();
        if (newEnabled !== null) {
          const { soundEnabled, enabledSounds } =
            useNotificationSettingsStore.getState();
          const type = newEnabled ? 'unmute' : 'mute';
          if (soundEnabled && enabledSounds[type]) soundManager.play(type);
        }
      },
      'toggle-deafen': () => {
        if (useVoiceStore.getState().status !== 'connected') return;
        const newDeafened = toggleDeafen();
        if (newDeafened !== null) {
          const { soundEnabled, enabledSounds } =
            useNotificationSettingsStore.getState();
          const type = newDeafened ? 'mute' : 'unmute';
          if (soundEnabled && enabledSounds[type]) soundManager.play(type);
        }
      },
      // --- Channels ---
      'mark-channel-read': () => {
        const state = useTilingStore.getState();
        const focusedContent = state.panes[state.focusedPaneId];
        let channelId: string | undefined;
        if (focusedContent?.type === 'channel') {
          channelId = focusedContent.channelId;
        } else if (focusedContent?.type === 'dm') {
          channelId = focusedContent.conversationId;
        }
        if (!channelId) return;
        if (!useReadStateStore.getState().hasUnread(channelId)) return;
        const messages = useMessageStore.getState().byChannel[channelId];
        const lastMsg = messages?.[messages.length - 1];
        if (lastMsg) {
          useReadStateStore
            .getState()
            .updateReadState(channelId, lastMsg.id, 0);
          ackMessage(channelId, lastMsg.id).catch(() => {});
        }
      },
      'mark-server-read': () => {
        const serverId = useNavigationStore.getState().selectedServerId;
        if (!serverId) return;
        const channels = useChannelStore.getState().byServer[serverId] ?? [];
        for (const ch of channels) {
          if (!useReadStateStore.getState().hasUnread(ch.id)) continue;
          const messages = useMessageStore.getState().byChannel[ch.id];
          const lastMsg = messages?.[messages.length - 1];
          if (lastMsg) {
            useReadStateStore.getState().updateReadState(ch.id, lastMsg.id, 0);
            ackMessage(ch.id, lastMsg.id).catch(() => {});
          }
        }
      },
    }),
    [onShowShortcuts],
  );

  const holdActions = useMemo<Partial<Record<KeybindId, HoldAction>>>(
    () => ({
      'push-to-mute': {
        onPress: () => {
          if (useVoiceStore.getState().status !== 'connected') return;
          toggleMute();
        },
        onRelease: () => {
          if (useVoiceStore.getState().status !== 'connected') return;
          toggleMute();
        },
      },
      'push-to-deafen': {
        onPress: () => {
          if (useVoiceStore.getState().status !== 'connected') return;
          toggleDeafen();
        },
        onRelease: () => {
          if (useVoiceStore.getState().status !== 'connected') return;
          toggleDeafen();
        },
      },
    }),
    [],
  );

  const activeHolds = useRef(new Set<KeybindId>());

  // Mirror the latest action maps into a ref on every render. The two
  // effects below depend on [] (mount/unmount only), so reading from
  // `actionsRef.current` lets them see the latest closures without
  // tearing down + re-registering DOM/OS hotkeys on every parent render.
  // (Without this, a parent re-render would briefly drop globalShortcut
  // registrations during the 50ms debounce — undetectably flaky bug.)
  const actionsRef = useRef({ pressActions, holdActions });
  actionsRef.current = { pressActions, holdActions };

  useEffect(() => {
    const entries = Object.entries(KEYBINDS) as [KeybindId, Keybind][];

    function keydownHandler(e: KeyboardEvent) {
      for (const [id, def] of entries) {
        // Globally-registered bindings are dispatched by the main process
        // via electronAPI.keybinds.onFire — skip them here to avoid double-fire.
        if (useKeybindOverridesStore.getState().getEffectiveIsGlobal(id)) {
          continue;
        }
        const effectiveKeys = useKeybindOverridesStore
          .getState()
          .getEffectiveKeys(id);
        if (!effectiveKeys) continue;
        if (!matchesKeybind(e, effectiveKeys)) continue;
        if (shouldSuppressKeybind(e, def)) continue;

        // Voice-only keybinds are no-ops when not connected
        if (def.voiceOnly && useVoiceStore.getState().status !== 'connected') {
          continue;
        }

        // Hold-type keybinds
        if (def.type === 'hold') {
          if (e.repeat) return; // Suppress key repeat
          if (activeHolds.current.has(id)) return; // Already held
          activeHolds.current.add(id);
          if (def.hotkeyOptions?.preventDefault !== false) {
            e.preventDefault();
          }
          actionsRef.current.holdActions[id]?.onPress();
          return;
        }

        // Press-type keybinds
        if (def.hotkeyOptions?.preventDefault !== false) {
          e.preventDefault();
        }
        actionsRef.current.pressActions[id]?.();
        return;
      }
    }

    function keyupHandler(e: KeyboardEvent) {
      if (activeHolds.current.size === 0) return;

      for (const [id] of entries) {
        if (!activeHolds.current.has(id)) continue;
        // Symmetric with keydownHandler: globally-registered bindings are
        // released by the IPC release path, not by the DOM. Without this
        // skip, a focused window with a global hold binding would fire
        // both DOM keyup (release) AND IPC release — toggling mute twice.
        if (useKeybindOverridesStore.getState().getEffectiveIsGlobal(id)) {
          continue;
        }
        const effectiveKeys = useKeybindOverridesStore
          .getState()
          .getEffectiveKeys(id);
        if (!effectiveKeys) continue;
        // On keyup, check if the primary key matches (modifiers may already be released)
        const parts = effectiveKeys.toLowerCase().split('+');
        const primaryKey = parts[parts.length - 1];
        if (e.key.toLowerCase() === primaryKey) {
          activeHolds.current.delete(id);
          actionsRef.current.holdActions[id]?.onRelease();
        }
      }
    }

    function blurHandler() {
      // Release all held keys when window loses focus
      for (const id of activeHolds.current) {
        actionsRef.current.holdActions[id]?.onRelease();
      }
      activeHolds.current.clear();
    }

    document.addEventListener('keydown', keydownHandler, true);
    document.addEventListener('keyup', keyupHandler);
    window.addEventListener('blur', blurHandler);
    return () => {
      document.removeEventListener('keydown', keydownHandler, true);
      document.removeEventListener('keyup', keyupHandler);
      window.removeEventListener('blur', blurHandler);
      // Release any active holds on cleanup
      for (const id of activeHolds.current) {
        actionsRef.current.holdActions[id]?.onRelease();
      }
      activeHolds.current.clear();
    };
  }, []);

  // ── Bridge to the Electron main process for OS-level global keybinds ──
  // On override change, push the snapshot to main; main re-registers
  // globalShortcut accordingly. When main fires, dispatch through the
  // same action map the in-window listener uses.
  useEffect(() => {
    const api = window.electronAPI;
    if (!api) return; // Web/mobile: no-op
    if (import.meta.env?.VITE_E2E === '1') return;

    // Cancellation token for in-flight `keybind:fire` IPC events. After
    // unsubscribe, microtasks already in the queue may still fire — they
    // would dispatch into the previous closure's actionsRef. Setting
    // `cancelled = true` on cleanup makes them a no-op.
    const cancelled = { value: false };

    function buildSnapshot(): KeybindSyncedBinding[] {
      const entries = Object.entries(KEYBINDS) as [KeybindId, Keybind][];
      const out: KeybindSyncedBinding[] = [];
      for (const [id, def] of entries) {
        if (!isGlobalEligible(id)) continue;
        const isGlobal = useKeybindOverridesStore
          .getState()
          .getEffectiveIsGlobal(id);
        if (!isGlobal) continue;
        const keys = useKeybindOverridesStore.getState().getEffectiveKeys(id);
        out.push({
          id,
          keys,
          type: def.type ?? 'press',
          isGlobal: true,
        });
      }
      return out;
    }

    function pushSync() {
      api?.keybinds
        .sync(buildSnapshot())
        .then((result) => {
          if (cancelled.value) return;
          useKeybindGlobalStatusStore
            .getState()
            .setStatus(
              result.status as Partial<
                Record<KeybindId, ElectronKeybindGlobalStatus>
              >,
            );
        })
        .catch(() => {
          // Main process should never throw, but if the IPC fails we leave
          // the in-window listener as the fallback.
        });
    }

    pushSync();
    const unsubscribeStore = useKeybindOverridesStore.subscribe(pushSync);

    const unsubscribeFire = api.keybinds.onFire((event) => {
      if (cancelled.value) return;
      const id = event.id as KeybindId;
      if (!(id in KEYBINDS)) return;
      const def: Keybind = KEYBINDS[id];
      if (def.voiceOnly && useVoiceStore.getState().status !== 'connected') {
        return;
      }
      if (event.phase === 'press') {
        if (def.type === 'hold') {
          if (activeHolds.current.has(id)) return;
          activeHolds.current.add(id);
          actionsRef.current.holdActions[id]?.onPress();
        } else {
          actionsRef.current.pressActions[id]?.();
        }
      } else if (event.phase === 'release') {
        if (def.type === 'hold' && activeHolds.current.has(id)) {
          activeHolds.current.delete(id);
          actionsRef.current.holdActions[id]?.onRelease();
        }
      }
    });

    return () => {
      cancelled.value = true;
      unsubscribeStore();
      unsubscribeFire();
      // Tell main to drop all global registrations on unmount. Don't
      // clear the global status store here — under React StrictMode the
      // remount's pushSync will overwrite it; clearing produces an
      // empty-frame flicker in the settings UI.
      api?.keybinds.sync([]).catch(() => {});
    };
  }, []);
}
