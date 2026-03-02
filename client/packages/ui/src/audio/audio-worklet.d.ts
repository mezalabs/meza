/**
 * Ambient type declarations for AudioWorklet globals.
 *
 * These APIs exist in the AudioWorkletGlobalScope but are not included
 * in TypeScript's standard DOM lib types.
 */

/* eslint-disable @typescript-eslint/no-empty-object-type */

interface AudioWorkletProcessorConstructor {
  new (): AudioWorkletProcessor;
}

/** Base class available inside AudioWorkletGlobalScope. */
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
}

/** Register a custom AudioWorkletProcessor class by name. */
declare function registerProcessor(
  name: string,
  processorCtor: AudioWorkletProcessorConstructor,
): void;
