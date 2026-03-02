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
import type {
  AudioProcessorOptions,
  Track,
  TrackProcessor,
} from 'livekit-client';

// Resolve worklet URL at build time via Vite's ?url import
import rnnoiseWorkletUrl from './rnnoise-worklet.ts?url';

/** Singleton: whether the worklet module has been registered on an AudioContext. */
const registeredContexts = new WeakSet<AudioContext>();

export type VadListener = (probability: number) => void;

export class RnnoiseTrackProcessor
  implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions>
{
  name = 'rnnoise-noise-suppression';
  processedTrack?: MediaStreamTrack;

  private audioContext?: AudioContext;
  private ownsAudioContext = false;
  private sourceNode?: MediaStreamAudioSourceNode;
  private workletNode?: AudioWorkletNode;
  private destinationNode?: MediaStreamAudioDestinationNode;
  private vadListener?: VadListener;
  private restartPromise?: Promise<void>;

  /** Register a callback that receives smoothed VAD probability (0–1). */
  onVad(listener: VadListener | undefined): void {
    this.vadListener = listener;
  }

  /** Send threshold (0–1) to the worklet. Frames below this are silenced. */
  setThreshold(value: number): void {
    this.workletNode?.port.postMessage({ type: 'threshold', value });
  }

  async init(opts: AudioProcessorOptions): Promise<void> {
    // LiveKit may not provide audioContext during unmute/restart flows
    if (opts.audioContext) {
      this.audioContext = opts.audioContext;
      this.ownsAudioContext = false;
    } else {
      this.audioContext = new AudioContext();
      this.ownsAudioContext = true;
    }

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

    // Listen for VAD probability messages from the worklet
    this.workletNode.port.onmessage = (e: MessageEvent) => {
      if (e.data?.type === 'vad' && this.vadListener) {
        this.vadListener(e.data.value);
      }
    };

    // Create destination to capture the processed audio
    this.destinationNode = this.audioContext.createMediaStreamDestination();

    // Wire the audio graph: source -> rnnoise worklet -> destination
    this.sourceNode.connect(this.workletNode);
    this.workletNode.connect(this.destinationNode);

    // Expose the processed track for LiveKit
    this.processedTrack = this.destinationNode.stream.getAudioTracks()[0];
  }

  async restart(opts: AudioProcessorOptions): Promise<void> {
    // Serialize concurrent restart calls so they don't interleave.
    const doRestart = async () => {
      // Preserve our AudioContext across restarts if LiveKit doesn't provide one
      const ctx = this.audioContext;
      const owns = this.ownsAudioContext;
      this.ownsAudioContext = false; // prevent destroy() from closing it
      await this.destroy();
      if (opts.audioContext || !ctx || ctx.state === 'closed') {
        await this.init(opts);
      } else {
        await this.init({ ...opts, audioContext: ctx });
        this.ownsAudioContext = owns;
      }
    };

    const prev = this.restartPromise;
    this.restartPromise = (prev ?? Promise.resolve()).then(
      doRestart,
      doRestart,
    );
    await this.restartPromise;
  }

  async destroy(): Promise<void> {
    if (this.workletNode) {
      this.workletNode.port.onmessage = null;
    }
    this.sourceNode?.disconnect();
    this.workletNode?.disconnect();
    this.destinationNode?.disconnect();
    this.sourceNode = undefined;
    this.workletNode = undefined;
    this.destinationNode = undefined;
    this.processedTrack = undefined;
    if (this.ownsAudioContext && this.audioContext) {
      await this.audioContext.close();
    }
    this.audioContext = undefined;
    this.ownsAudioContext = false;
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
