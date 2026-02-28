import type {
  ScreenSharePresetKey,
  StreamSettingsState,
  ViewerQuality,
} from '@meza/core';
import type {
  ScreenShareCaptureOptions,
  TrackPublishOptions,
  VideoPreset,
} from 'livekit-client';
import { ScreenSharePresets, VideoQuality } from 'livekit-client';

/** Map a user-facing preset key to the LiveKit ScreenSharePreset. */
export function getScreenSharePreset(key: ScreenSharePresetKey): VideoPreset {
  return ScreenSharePresets[key];
}

const SIMULCAST_LAYER_MAP: Record<
  ScreenSharePresetKey,
  ScreenSharePresetKey[]
> = {
  h1080fps30: ['h720fps15', 'h360fps3'],
  h1080fps15: ['h720fps5', 'h360fps3'],
  h720fps30: ['h360fps15'],
  h720fps15: ['h360fps3'],
  h720fps5: ['h360fps3'],
  h360fps15: ['h360fps3'],
  h360fps3: [],
  original: ['h720fps15', 'h360fps3'],
};

/** Derive simulcast layers from the selected preset. */
export function getSimulcastLayers(key: ScreenSharePresetKey): VideoPreset[] {
  return SIMULCAST_LAYER_MAP[key].map((k) => ScreenSharePresets[k]);
}

const isSafari =
  typeof navigator !== 'undefined' &&
  /^((?!chrome|android).)*safari/i.test(navigator.userAgent);

/** Build ScreenShareCaptureOptions from store state. */
export function buildCaptureOptions(
  state: StreamSettingsState,
): ScreenShareCaptureOptions {
  const preset = getScreenSharePreset(state.preset);

  return {
    audio: true,
    selfBrowserSurface: 'exclude',
    contentHint: state.contentHint,
    // Safari 17 bug: any resolution constraint leads to low-res capture.
    ...(isSafari ? {} : { resolution: preset.resolution }),
  };
}

/** Build TrackPublishOptions from store state. */
export function buildPublishOptions(
  state: StreamSettingsState,
): TrackPublishOptions {
  const preset = getScreenSharePreset(state.preset);

  return {
    screenShareEncoding: preset.encoding,
    ...(state.simulcast
      ? { screenShareSimulcastLayers: getSimulcastLayers(state.preset) }
      : {}),
  };
}

/** Map ViewerQuality to VideoQuality enum, or null for "auto". */
export function viewerQualityToVideoQuality(
  quality: ViewerQuality,
): VideoQuality | null {
  switch (quality) {
    case 'low':
      return VideoQuality.LOW;
    case 'medium':
      return VideoQuality.MEDIUM;
    case 'high':
      return VideoQuality.HIGH;
    case 'auto':
      return null;
  }
}
