import {
  updateProfile,
  useAudioSettingsStore,
  useVoiceStore,
} from '@meza/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useMediaDevices } from '../../hooks/useMediaDevices.ts';

const supportsOutputDeviceSelection =
  typeof HTMLMediaElement !== 'undefined' &&
  'setSinkId' in HTMLMediaElement.prototype;

export function VoiceAudioSection() {
  const {
    audioInputs,
    audioOutputs,
    error: deviceError,
    hasPermission,
    requestPermission,
  } = useMediaDevices();

  const inputDeviceId = useAudioSettingsStore((s) => s.inputDeviceId);
  const outputDeviceId = useAudioSettingsStore((s) => s.outputDeviceId);
  const inputGain = useAudioSettingsStore((s) => s.inputGain);
  const outputVolume = useAudioSettingsStore((s) => s.outputVolume);
  const soundboardVolume = useAudioSettingsStore((s) => s.soundboardVolume);
  const hearOwnSoundboard = useAudioSettingsStore((s) => s.hearOwnSoundboard);
  const noiseSuppression = useAudioSettingsStore((s) => s.noiseSuppression);
  const echoCancellation = useAudioSettingsStore((s) => s.echoCancellation);
  const autoGainControl = useAudioSettingsStore((s) => s.autoGainControl);
  const voiceStatus = useVoiceStore((s) => s.status);
  const isInCall =
    voiceStatus === 'connected' || voiceStatus === 'reconnecting';

  const [feedback, setFeedback] = useState<{
    type: 'success' | 'error';
    message: string;
  } | null>(null);

  // Auto-request permission on mount
  useEffect(() => {
    if (!hasPermission) {
      requestPermission();
    }
  }, [hasPermission, requestPermission]);

  // Stale device check: if stored device is not in the list, clear it
  useEffect(() => {
    if (
      inputDeviceId &&
      audioInputs.length > 0 &&
      !audioInputs.some((d) => d.deviceId === inputDeviceId)
    ) {
      useAudioSettingsStore.getState().setInputDevice(null);
    }
  }, [inputDeviceId, audioInputs]);

  useEffect(() => {
    if (
      outputDeviceId &&
      audioOutputs.length > 0 &&
      !audioOutputs.some((d) => d.deviceId === outputDeviceId)
    ) {
      useAudioSettingsStore.getState().setOutputDevice(null);
    }
  }, [outputDeviceId, audioOutputs]);

  // Debounced server sync for processing toggles
  const syncTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const syncToServer = useCallback(
    (prefs: {
      noiseSuppression: boolean;
      echoCancellation: boolean;
      autoGainControl: boolean;
    }) => {
      clearTimeout(syncTimerRef.current);
      syncTimerRef.current = setTimeout(async () => {
        try {
          await updateProfile({ audioPreferences: prefs });
          setFeedback({ type: 'success', message: 'Saved.' });
        } catch {
          setFeedback({ type: 'error', message: 'Failed to save.' });
        }
      }, 500);
    },
    [],
  );

  useEffect(() => {
    return () => clearTimeout(syncTimerRef.current);
  }, []);

  function handleToggle(
    field: 'noiseSuppression' | 'echoCancellation' | 'autoGainControl',
  ) {
    const store = useAudioSettingsStore.getState();
    const newValue = !store[field];
    const setter = {
      noiseSuppression: store.setNoiseSuppression,
      echoCancellation: store.setEchoCancellation,
      autoGainControl: store.setAutoGainControl,
    }[field];
    setter(newValue);
    setFeedback(null);
    syncToServer({
      noiseSuppression:
        field === 'noiseSuppression' ? newValue : store.noiseSuppression,
      echoCancellation:
        field === 'echoCancellation' ? newValue : store.echoCancellation,
      autoGainControl:
        field === 'autoGainControl' ? newValue : store.autoGainControl,
    });
  }

  return (
    <div className="max-w-md space-y-6">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-text-subtle">
        Voice & Audio
      </h2>

      {deviceError && (
        <div className="rounded-md bg-error/10 px-3 py-2 text-sm text-error">
          {deviceError}
        </div>
      )}

      {/* Input Device */}
      <div className="space-y-3">
        <label
          htmlFor="audio-input-device"
          className="block text-sm font-medium text-text"
        >
          Input Device
        </label>
        <select
          id="audio-input-device"
          className="w-full rounded-md border border-border bg-bg-surface px-3 py-2 text-sm text-text focus:border-accent focus:outline-none"
          value={inputDeviceId ?? ''}
          onChange={(e) =>
            useAudioSettingsStore
              .getState()
              .setInputDevice(e.target.value || null)
          }
          disabled={!hasPermission}
        >
          <option value="">Default</option>
          {audioInputs.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label || `Microphone ${d.deviceId.slice(0, 8)}`}
            </option>
          ))}
        </select>

        <label
          htmlFor="audio-input-gain"
          className="block text-sm font-medium text-text"
        >
          Input Volume
        </label>
        <div className="flex items-center gap-4">
          <input
            id="audio-input-gain"
            type="range"
            min={0}
            max={200}
            step={1}
            value={Math.round(inputGain * 100)}
            onChange={(e) =>
              useAudioSettingsStore
                .getState()
                .setInputGain(Number(e.target.value) / 100)
            }
            className="flex-1 accent-accent"
            aria-valuemin={0}
            aria-valuemax={200}
            aria-valuenow={Math.round(inputGain * 100)}
          />
          <span className="w-12 text-right text-sm tabular-nums text-text-muted">
            {Math.round(inputGain * 100)}%
          </span>
        </div>
      </div>

      {/* Output Device */}
      {supportsOutputDeviceSelection && (
        <div className="space-y-3">
          <label
            htmlFor="audio-output-device"
            className="block text-sm font-medium text-text"
          >
            Output Device
          </label>
          <select
            id="audio-output-device"
            className="w-full rounded-md border border-border bg-bg-surface px-3 py-2 text-sm text-text focus:border-accent focus:outline-none"
            value={outputDeviceId ?? ''}
            onChange={(e) =>
              useAudioSettingsStore
                .getState()
                .setOutputDevice(e.target.value || null)
            }
          >
            <option value="">Default</option>
            {audioOutputs.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || `Speaker ${d.deviceId.slice(0, 8)}`}
              </option>
            ))}
          </select>

          <label
            htmlFor="audio-output-volume"
            className="block text-sm font-medium text-text"
          >
            Output Volume
          </label>
          <div className="flex items-center gap-4">
            <input
              id="audio-output-volume"
              type="range"
              min={0}
              max={100}
              step={1}
              value={Math.round(outputVolume * 100)}
              onChange={(e) =>
                useAudioSettingsStore
                  .getState()
                  .setOutputVolume(Number(e.target.value) / 100)
              }
              className="flex-1 accent-accent"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(outputVolume * 100)}
            />
            <span className="w-12 text-right text-sm tabular-nums text-text-muted">
              {Math.round(outputVolume * 100)}%
            </span>
          </div>
        </div>
      )}

      {/* Audio Processing */}
      <div className="space-y-3">
        <span className="block text-sm font-medium text-text">
          Audio Processing
        </span>

        <ToggleSwitch
          id="audio-noise-suppression"
          label="Noise Suppression"
          checked={noiseSuppression}
          onToggle={() => handleToggle('noiseSuppression')}
        />
        <ToggleSwitch
          id="audio-echo-cancellation"
          label="Echo Cancellation"
          checked={echoCancellation}
          onToggle={() => handleToggle('echoCancellation')}
        />
        <ToggleSwitch
          id="audio-agc"
          label="Auto Gain Control"
          checked={autoGainControl}
          onToggle={() => handleToggle('autoGainControl')}
        />
      </div>

      {/* Soundboard */}
      <div className="space-y-3">
        <span className="block text-sm font-medium text-text">Soundboard</span>

        <label
          htmlFor="audio-soundboard-volume"
          className="block text-sm text-text-muted"
        >
          Soundboard Volume
        </label>
        <p className="text-xs text-text-subtle">
          Adjusts how loud soundboard sounds from other participants are for
          you.
        </p>
        <div className="flex items-center gap-4">
          <input
            id="audio-soundboard-volume"
            type="range"
            min={0}
            max={200}
            step={1}
            value={Math.round(soundboardVolume * 100)}
            onChange={(e) =>
              useAudioSettingsStore
                .getState()
                .setSoundboardVolume(Number(e.target.value) / 100)
            }
            className="flex-1 accent-accent"
            aria-valuemin={0}
            aria-valuemax={200}
            aria-valuenow={Math.round(soundboardVolume * 100)}
          />
          <span className="w-12 text-right text-sm tabular-nums text-text-muted">
            {Math.round(soundboardVolume * 100)}%
          </span>
        </div>

        <ToggleSwitch
          id="audio-hear-own-soundboard"
          label="Hear Own Soundboard Sounds"
          checked={hearOwnSoundboard}
          onToggle={() => {
            const store = useAudioSettingsStore.getState();
            store.setHearOwnSoundboard(!store.hearOwnSoundboard);
          }}
        />
      </div>

      {/* Mic Test */}
      <div className="space-y-3">
        <span className="block text-sm font-medium text-text">Mic Test</span>
        <MicTest
          inputDeviceId={inputDeviceId}
          disabled={isInCall || !hasPermission}
          disabledReason={
            isInCall
              ? 'Leave voice channel to test your microphone'
              : !hasPermission
                ? 'Grant microphone access first'
                : undefined
          }
        />
      </div>

      {feedback && (
        <output
          className={`text-sm ${
            feedback.type === 'success' ? 'text-success' : 'text-error'
          }`}
        >
          {feedback.message}
        </output>
      )}
    </div>
  );
}

function ToggleSwitch({
  id,
  label,
  checked,
  onToggle,
}: {
  id: string;
  label: string;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="flex items-center gap-3">
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={onToggle}
        className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors ${
          checked ? 'bg-accent' : 'bg-bg-surface'
        }`}
      >
        <span
          className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${
            checked ? 'translate-x-5' : 'translate-x-0.5'
          } mt-0.5`}
        />
      </button>
      <label htmlFor={id} className="text-sm text-text-muted cursor-pointer">
        {label}
      </label>
    </div>
  );
}

function MicTest({
  inputDeviceId,
  disabled,
  disabledReason,
}: {
  inputDeviceId: string | null;
  disabled: boolean;
  disabledReason?: string;
}) {
  const [isTesting, setIsTesting] = useState(false);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);

  const stop = useCallback(() => {
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) {
        track.stop();
      }
      streamRef.current = null;
    }
    if (audioCtxRef.current) {
      audioCtxRef.current.close();
      audioCtxRef.current = null;
    }
    setIsTesting(false);
  }, []);

  const start = useCallback(async () => {
    try {
      const constraints: MediaStreamConstraints = {
        audio: inputDeviceId ? { deviceId: { ideal: inputDeviceId } } : true,
      };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      streamRef.current = stream;

      const ctx = new AudioContext();
      audioCtxRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      source.connect(ctx.destination);
      setIsTesting(true);
    } catch {
      stop();
    }
  }, [inputDeviceId, stop]);

  // Cleanup on unmount
  useEffect(() => {
    return () => stop();
  }, [stop]);

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={isTesting ? stop : start}
      className="rounded-md bg-bg-surface px-4 py-2 text-sm font-medium text-text transition-colors hover:bg-bg-elevated disabled:opacity-50"
      title={disabled ? disabledReason : undefined}
    >
      {isTesting ? 'Stop Test' : 'Test Microphone'}
    </button>
  );
}
