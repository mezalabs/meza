import { useLocalParticipant } from '@livekit/components-react';
import type { ScreenSource } from '@meza/core';
import { useStreamSettingsStore } from '@meza/core';
import { useCallback, useState } from 'react';
import {
  buildCaptureOptions,
  buildPublishOptions,
} from '../utils/streamPresets.ts';

// IMPORTANT: Module-level guard, NOT a useRef().
// Two components (VoicePanel, VoiceConnectionBar) call this hook
// independently. A useRef would give each its own guard, creating
// a race condition where both components start screen sharing
// simultaneously.
let isToggling = false;

export interface UseScreenShareToggleResult {
  toggle: () => Promise<void>;
  isSharing: boolean;
  pickerOpen: boolean;
  sources: ScreenSource[] | null;
  selectedSourceId: string | null;
  setSelectedSourceId: (id: string | null) => void;
  confirmShare: () => Promise<void>;
  cancelPicker: () => void;
  pickerError: string | null;
  retryGetSources: () => Promise<void>;
}

export function useScreenShareToggle(
  canScreenShare: boolean,
): UseScreenShareToggleResult {
  const { localParticipant } = useLocalParticipant();
  const isSharing = localParticipant.isScreenShareEnabled;
  const [pickerOpen, setPickerOpen] = useState(false);
  const [sources, setSources] = useState<ScreenSource[] | null>(null);
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);
  const [pickerError, setPickerError] = useState<string | null>(null);

  const fetchSources = useCallback(async () => {
    setPickerError(null);
    setSources(null);
    try {
      const result = await window.electronAPI?.screenShare?.getSources();
      if (result === null || result === undefined) {
        // null = Wayland or no electronAPI; skip picker, share directly
        const state = useStreamSettingsStore.getState();
        await localParticipant.setScreenShareEnabled(
          true,
          buildCaptureOptions(state),
          buildPublishOptions(state),
        );
        return false; // signals: don't open picker
      }
      setSources(result);
      return true; // signals: open picker
    } catch {
      setPickerError('Unable to list screens. Please check permissions.');
      return true; // still open picker to show error state
    }
  }, [localParticipant]);

  const toggle = useCallback(async () => {
    if (!canScreenShare || isToggling) return;
    isToggling = true;
    try {
      if (isSharing) {
        await localParticipant.setScreenShareEnabled(false);
      } else if (window.electronAPI?.screenShare) {
        const shouldOpenPicker = await fetchSources();
        if (shouldOpenPicker) {
          setPickerOpen(true);
        }
      } else {
        // Web fallback: use browser's native getDisplayMedia
        const state = useStreamSettingsStore.getState();
        await localParticipant.setScreenShareEnabled(
          true,
          buildCaptureOptions(state),
          buildPublishOptions(state),
        );
      }
    } catch {
      // User cancelled or getDisplayMedia failed — no-op
    } finally {
      isToggling = false;
    }
  }, [canScreenShare, isSharing, localParticipant, fetchSources]);

  const confirmShare = useCallback(async () => {
    if (!selectedSourceId || isToggling) return;
    isToggling = true;
    try {
      const result =
        await window.electronAPI?.screenShare?.select(selectedSourceId);
      if (!result?.success) {
        // Source disappeared — re-enumerate
        setPickerError('That source is no longer available.');
        setSelectedSourceId(null);
        const freshSources =
          await window.electronAPI?.screenShare?.getSources();
        if (freshSources) setSources(freshSources);
        return;
      }

      setPickerOpen(false);
      setSources(null);
      setSelectedSourceId(null);
      setPickerError(null);

      const state = useStreamSettingsStore.getState();
      await localParticipant.setScreenShareEnabled(
        true,
        buildCaptureOptions(state),
        buildPublishOptions(state),
      );
    } catch {
      // getDisplayMedia failed — no-op
    } finally {
      isToggling = false;
    }
  }, [selectedSourceId, localParticipant]);

  const cancelPicker = useCallback(() => {
    setPickerOpen(false);
    setSources(null);
    setSelectedSourceId(null);
    setPickerError(null);
  }, []);

  const retryGetSources = useCallback(async () => {
    setPickerError(null);
    setSources(null);
    try {
      const result = await window.electronAPI?.screenShare?.getSources();
      if (result) setSources(result);
    } catch {
      setPickerError('Unable to list screens. Please check permissions.');
    }
  }, []);

  return {
    toggle,
    isSharing,
    pickerOpen,
    sources,
    selectedSourceId,
    setSelectedSourceId,
    confirmShare,
    cancelPicker,
    pickerError,
    retryGetSources,
  };
}
