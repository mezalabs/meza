import {
  ackMessage,
  KEYBINDS,
  type Keybind,
  type KeybindId,
  matchesKeybind,
  shouldSuppressKeybind,
  soundManager,
  useChannelStore,
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

  useEffect(() => {
    const entries = Object.entries(KEYBINDS) as [KeybindId, Keybind][];

    function keydownHandler(e: KeyboardEvent) {
      if (e.defaultPrevented) return;

      for (const [id, def] of entries) {
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
          holdActions[id]?.onPress();
          return;
        }

        // Press-type keybinds
        if (def.hotkeyOptions?.preventDefault !== false) {
          e.preventDefault();
        }
        pressActions[id]?.();
        return;
      }
    }

    function keyupHandler(e: KeyboardEvent) {
      if (activeHolds.current.size === 0) return;

      for (const [id] of entries) {
        if (!activeHolds.current.has(id)) continue;
        const effectiveKeys = useKeybindOverridesStore
          .getState()
          .getEffectiveKeys(id);
        if (!effectiveKeys) continue;
        // On keyup, check if the primary key matches (modifiers may already be released)
        const parts = effectiveKeys.toLowerCase().split('+');
        const primaryKey = parts[parts.length - 1];
        if (e.key.toLowerCase() === primaryKey) {
          activeHolds.current.delete(id);
          holdActions[id]?.onRelease();
        }
      }
    }

    function blurHandler() {
      // Release all held keys when window loses focus
      for (const id of activeHolds.current) {
        holdActions[id]?.onRelease();
      }
      activeHolds.current.clear();
    }

    document.addEventListener('keydown', keydownHandler);
    document.addEventListener('keyup', keyupHandler);
    window.addEventListener('blur', blurHandler);
    return () => {
      document.removeEventListener('keydown', keydownHandler);
      document.removeEventListener('keyup', keyupHandler);
      window.removeEventListener('blur', blurHandler);
      // Release any active holds on cleanup
      for (const id of activeHolds.current) {
        holdActions[id]?.onRelease();
      }
      activeHolds.current.clear();
    };
  }, [pressActions, holdActions]);
}
