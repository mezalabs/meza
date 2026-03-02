/**
 * LiveKit TrackProcessor that applies RNNoise noise suppression to audio.
 *
 * Usage:
 *   const processor = new RnnoiseTrackProcessor();
 *   await localAudioTrack.setProcessor(processor);
 *
 * The processor creates an AudioWorkletNode that runs RNNoise WASM,
 * routing: source -> worklet -> destination, and exposes the denoised
 * MediaStreamTrack as `processedTrack` for LiveKit to use.
 */
import type { AudioProcessorOptions, TrackProcessor } from 'livekit-client';
import { Track } from 'livekit-client';

// Resolve worklet URL at build time via Vite's ?url import
import rnnoiseWorkletUrl from './rnnoise-worklet.ts?url';

/** Singleton: whether the worklet module has been registered on an AudioContext. */
const registeredContexts = new WeakSet<AudioContext>();

export class RnnoiseTrackProcessor
  implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions>
{
  name = 'rnnoise-noise-suppression';
  processedTrack?: MediaStreamTrack;

  private audioContext?: AudioContext;
  private sourceNode?: MediaStreamAudioSourceNode;
  private workletNode?: AudioWorkletNode;
  private destinationNode?: MediaStreamAudioDestinationNode;

  async init(opts: AudioProcessorOptions): Promise<void> {
    this.audioContext = opts.audioContext;

    // Register the worklet module once per AudioContext
    if (!registeredContexts.has(this.audioContext)) {
      await this.audioContext.audioWorklet.addModule(rnnoiseWorkletUrl);
      registeredContexts.add(this.audioContext);
    }

    // Create source from the raw mic track
    const sourceStream = new MediaStream([opts.track]);
    this.sourceNode = this.audioContext.createMediaStreamSource(sourceStream);

    // Create the RNNoise AudioWorklet node (mono)
    this.workletNode = new AudioWorkletNode(
      this.audioContext,
      'rnnoise-processor',
      {
        channelCount: 1,
        channelCountMode: 'explicit',
        numberOfInputs: 1,
        numberOfOutputs: 1,
      },
    );

    // Create destination to capture the processed audio
    this.destinationNode = this.audioContext.createMediaStreamDestination();

    // Wire the audio graph: source -> rnnoise worklet -> destination
    this.sourceNode.connect(this.workletNode);
    this.workletNode.connect(this.destinationNode);

    // Expose the processed track for LiveKit
    this.processedTrack = this.destinationNode.stream.getAudioTracks()[0];
  }

  async restart(opts: AudioProcessorOptions): Promise<void> {
    await this.destroy();
    await this.init(opts);
  }

  async destroy(): Promise<void> {
    this.sourceNode?.disconnect();
    this.workletNode?.disconnect();
    this.destinationNode?.disconnect();
    this.sourceNode = undefined;
    this.workletNode = undefined;
    this.destinationNode = undefined;
    this.processedTrack = undefined;
  }
}

/**
 * Pre-loads the worklet module URL so the browser can cache it.
 * Call this early (e.g. on gateway connection) if the user has GIGA mode enabled.
 */
export function preloadRnnoiseWorklet(): void {
  // Simple link preload — browser will cache the JS file
  if (typeof document !== 'undefined') {
    const link = document.createElement('link');
    link.rel = 'modulepreload';
    link.href = rnnoiseWorkletUrl;
    document.head.appendChild(link);
  }
}
