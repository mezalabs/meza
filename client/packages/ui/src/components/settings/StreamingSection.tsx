import type {
  ContentHint,
  ScreenSharePresetKey,
  ViewerQuality,
} from '@meza/core';
import { useStreamSettingsStore, useVoiceStore } from '@meza/core';
import { useLocalParticipant } from '@livekit/components-react';

const PRESET_OPTIONS: { value: ScreenSharePresetKey; label: string }[] = [
  { value: 'h360fps3', label: '360p \u00B7 3 fps (Low bandwidth)' },
  { value: 'h360fps15', label: '360p \u00B7 15 fps' },
  { value: 'h720fps5', label: '720p \u00B7 5 fps' },
  { value: 'h720fps15', label: '720p \u00B7 15 fps' },
  { value: 'h720fps30', label: '720p \u00B7 30 fps' },
  { value: 'h1080fps15', label: '1080p \u00B7 15 fps' },
  { value: 'h1080fps30', label: '1080p \u00B7 30 fps (Recommended)' },
  { value: 'original', label: 'Original (Native resolution)' },
];

const QUALITY_OPTIONS: { value: ViewerQuality; label: string }[] = [
  { value: 'auto', label: 'Auto (Recommended)' },
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low', label: 'Low' },
];

export function StreamingSection() {
  const preset = useStreamSettingsStore((s) => s.preset);
  const contentHint = useStreamSettingsStore((s) => s.contentHint);
  const simulcast = useStreamSettingsStore((s) => s.simulcast);
  const defaultQuality = useStreamSettingsStore((s) => s.defaultQuality);

  const isSharing = useIsScreenSharing();

  return (
    <div className="max-w-md space-y-6">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-text-subtle">
        Streaming
      </h2>

      {/* Publisher settings */}
      <div className="space-y-4">
        <h3 className="text-sm font-medium text-text">Screen Share Quality</h3>

        {isSharing && (
          <p className="text-xs text-warning">
            Changes apply next time you share your screen.
          </p>
        )}

        {/* Quality preset */}
        <div className="space-y-1.5">
          <label
            htmlFor="stream-preset"
            className="block text-sm text-text-muted"
          >
            Quality preset
          </label>
          <select
            id="stream-preset"
            className="w-full rounded-md border border-border bg-bg-surface px-3 py-2 text-sm text-text focus:border-accent focus:outline-none"
            value={preset}
            onChange={(e) =>
              useStreamSettingsStore
                .getState()
                .setPreset(e.target.value as ScreenSharePresetKey)
            }
          >
            {PRESET_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        {/* Content optimization */}
        <div className="space-y-1.5">
          <label
            htmlFor="content-hint"
            className="block text-sm text-text-muted"
          >
            Optimize for
          </label>
          <select
            id="content-hint"
            className="w-full rounded-md border border-border bg-bg-surface px-3 py-2 text-sm text-text focus:border-accent focus:outline-none"
            value={contentHint}
            onChange={(e) =>
              useStreamSettingsStore
                .getState()
                .setContentHint(e.target.value as ContentHint)
            }
          >
            <option value="detail">Text & images (sharper)</option>
            <option value="motion">Video & animation (smoother)</option>
          </select>
        </div>

        {/* Simulcast toggle */}
        <div className="space-y-1.5">
          <div className="flex items-center gap-3">
            <button
              id="simulcast-toggle"
              type="button"
              role="switch"
              aria-checked={simulcast}
              onClick={() =>
                useStreamSettingsStore.getState().setSimulcast(!simulcast)
              }
              className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors ${
                simulcast ? 'bg-accent' : 'bg-bg-surface'
              }`}
            >
              <span
                className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${
                  simulcast ? 'translate-x-5' : 'translate-x-0.5'
                } mt-0.5`}
              />
            </button>
            <label
              htmlFor="simulcast-toggle"
              className="text-sm text-text-muted cursor-pointer"
            >
              Multi-quality broadcasting
            </label>
          </div>
          <p className="text-xs text-text-subtle pl-14">
            Publish multiple quality layers so viewers can choose their
            preferred quality. Uses more upload bandwidth.
          </p>
        </div>
      </div>

      {/* Viewer settings */}
      <div className="space-y-4">
        <h3 className="text-sm font-medium text-text">Viewing</h3>

        <div className="space-y-1.5">
          <label
            htmlFor="viewer-quality"
            className="block text-sm text-text-muted"
          >
            Default quality
          </label>
          <select
            id="viewer-quality"
            className="w-full rounded-md border border-border bg-bg-surface px-3 py-2 text-sm text-text focus:border-accent focus:outline-none"
            value={defaultQuality}
            onChange={(e) =>
              useStreamSettingsStore
                .getState()
                .setDefaultQuality(e.target.value as ViewerQuality)
            }
          >
            {QUALITY_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          <p className="text-xs text-text-subtle">
            Quality preference for incoming screen shares. Only applies when the
            sharer has multi-quality broadcasting enabled.
          </p>
        </div>
      </div>
    </div>
  );
}

/** Check if the local user is currently sharing their screen. */
function useIsScreenSharing(): boolean {
  const voiceStatus = useVoiceStore((s) => s.status);
  const { localParticipant } = useLocalParticipant();
  return voiceStatus === 'connected' && localParticipant.isScreenShareEnabled;
}
