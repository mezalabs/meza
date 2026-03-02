/**
 * AudioWorkletProcessor that runs RNNoise WASM for noise suppression.
 *
 * RNNoise processes fixed 480-sample frames (10ms at 48kHz).
 * AudioWorklet delivers 128-sample chunks per process() call.
 * A circular buffer (1920 samples = LCM of 128 and 480) bridges the mismatch.
 *
 * The WASM binary is inlined (base64) in rnnoise-sync.js so it compiles
 * synchronously inside the AudioWorkletGlobalScope (no async fetch).
 *
 * Messages from main thread:
 *   { type: 'threshold', value: number }  — VAD gate threshold (0–1)
 *
 * Messages to main thread:
 *   { type: 'vad', value: number }  — smoothed VAD probability (0–1)
 */

// @ts-expect-error — rnnoise-sync.js has no type declarations
import createRNNWasmModuleSync from '@jitsi/rnnoise-wasm/dist/rnnoise-sync';

/** RNNoise frame size in samples (10ms at 48kHz). */
const DENOISE_SAMPLE_SIZE = 480;

/** AudioWorklet render quantum (fixed by spec). */
const PROC_NODE_SAMPLE_RATE = 128;

/** Circular buffer length — LCM of 128 and 480.  */
const BUFFER_SIZE = 1920;

/** Scale factor for float32 <-> int16 conversion (RNNoise expects ~int16 range). */
const PCM_SCALE = 0x7fff;

/** How often to send VAD probability to main thread (in process() calls ≈ every ~85ms). */
const VAD_REPORT_INTERVAL = 32;

/** EMA smoothing factor for VAD probability (lower = smoother). */
const VAD_SMOOTH_ALPHA = 0.3;

interface RnnoiseModule {
  _rnnoise_create: () => number;
  _rnnoise_destroy: (ptr: number) => void;
  _rnnoise_process_frame: (
    ptr: number,
    inputPtr: number,
    outputPtr: number,
  ) => number;
  _malloc: (bytes: number) => number;
  _free: (ptr: number) => void;
  HEAPF32: Float32Array;
}

class RnnoiseWorkletProcessor extends AudioWorkletProcessor {
  private module: RnnoiseModule;
  private statePtr: number;
  private inputPtr: number;
  private outputPtr: number;

  /** Circular buffer holding raw + denoised samples. */
  private circularBuffer: Float32Array;

  /** How many raw samples have been written into the buffer. */
  private inputBufferLength = 0;

  /** How far denoising has progressed in the buffer. */
  private denoisedBufferLength = 0;

  /** Read cursor: how many denoised samples have been output. */
  private denoisedBufferIndex = 0;

  /** VAD gate threshold (0–1). Frames below this probability are silenced. 0 = no gating. */
  private threshold = 0;

  /** Smoothed VAD probability for reporting. */
  private smoothedVad = 0;

  /** Counter for throttled VAD reporting. */
  private vadReportCounter = 0;

  constructor() {
    super();

    // Compile WASM synchronously (base64-inlined in rnnoise-sync.js)
    this.module = createRNNWasmModuleSync() as RnnoiseModule;

    // Create RNNoise denoiser state
    this.statePtr = this.module._rnnoise_create();

    // Allocate WASM heap buffers for one RNNoise frame (480 floats = 1920 bytes)
    const frameBytes = DENOISE_SAMPLE_SIZE * Float32Array.BYTES_PER_ELEMENT;
    this.inputPtr = this.module._malloc(frameBytes);
    this.outputPtr = this.module._malloc(frameBytes);

    this.circularBuffer = new Float32Array(BUFFER_SIZE);

    // Listen for threshold updates from main thread
    this.port.onmessage = (e: MessageEvent) => {
      if (e.data?.type === 'threshold') {
        this.threshold = Math.max(0, Math.min(1, e.data.value));
      }
    };
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    _parameters: Record<string, Float32Array>,
  ): boolean {
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];

    if (!input || !output) return true;

    const bufLen = this.circularBuffer.length;

    // 1. Write incoming 128 samples into the circular buffer
    const writeStart = this.inputBufferLength % bufLen;
    this.circularBuffer.set(input, writeStart);
    this.inputBufferLength += input.length;

    // 2. Denoise as many 480-sample frames as available
    while (
      this.inputBufferLength - this.denoisedBufferLength >=
      DENOISE_SAMPLE_SIZE
    ) {
      const denoiseStart = this.denoisedBufferLength % bufLen;

      // Convert float32 [-1,1] to float "int16" range for RNNoise
      const heapOffset = this.inputPtr / Float32Array.BYTES_PER_ELEMENT;
      for (let i = 0; i < DENOISE_SAMPLE_SIZE; i++) {
        this.module.HEAPF32[heapOffset + i] =
          this.circularBuffer[(denoiseStart + i) % bufLen] * PCM_SCALE;
      }

      // Process frame through RNNoise — returns VAD probability (0–1)
      const vadProb = this.module._rnnoise_process_frame(
        this.statePtr,
        this.outputPtr,
        this.inputPtr,
      );
      this.smoothedVad += VAD_SMOOTH_ALPHA * (vadProb - this.smoothedVad);

      // Write denoised samples back into the circular buffer (in-place),
      // converting back from int16 range to float32 [-1,1]
      const outHeapOffset = this.outputPtr / Float32Array.BYTES_PER_ELEMENT;

      // Apply VAD gate: if below threshold, output silence for this frame
      const gated = this.threshold > 0 && vadProb < this.threshold;

      for (let i = 0; i < DENOISE_SAMPLE_SIZE; i++) {
        this.circularBuffer[(denoiseStart + i) % bufLen] = gated
          ? 0
          : this.module.HEAPF32[outHeapOffset + i] / PCM_SCALE;
      }

      this.denoisedBufferLength += DENOISE_SAMPLE_SIZE;
    }

    // 3. Output 128 denoised samples if available
    const denoisedAvailable =
      this.denoisedBufferLength - this.denoisedBufferIndex;
    if (denoisedAvailable >= PROC_NODE_SAMPLE_RATE) {
      const readStart = this.denoisedBufferIndex % bufLen;
      for (let i = 0; i < PROC_NODE_SAMPLE_RATE; i++) {
        output[i] = this.circularBuffer[(readStart + i) % bufLen];
      }
      this.denoisedBufferIndex += PROC_NODE_SAMPLE_RATE;
    } else {
      // Not enough denoised data yet — output silence
      output.fill(0);
    }

    // Reset counters when all three cursors have passed the buffer boundary
    // to prevent integer overflow on long sessions
    if (
      this.denoisedBufferIndex >= bufLen &&
      this.denoisedBufferLength >= bufLen &&
      this.inputBufferLength >= bufLen
    ) {
      this.denoisedBufferIndex -= bufLen;
      this.denoisedBufferLength -= bufLen;
      this.inputBufferLength -= bufLen;
    }

    // 4. Periodically report VAD probability to main thread
    this.vadReportCounter++;
    if (this.vadReportCounter >= VAD_REPORT_INTERVAL) {
      this.vadReportCounter = 0;
      this.port.postMessage({ type: 'vad', value: this.smoothedVad });
    }

    return true;
  }
}

registerProcessor('rnnoise-processor', RnnoiseWorkletProcessor);
