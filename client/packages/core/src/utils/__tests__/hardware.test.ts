import { describe, expect, it, vi, afterEach } from 'vitest';
import { canRunGiga, supportsAudioWorklet } from '../hardware.ts';

describe('canRunGiga', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns true for capable hardware (>= 4 cores, >= 4GB memory)', () => {
    vi.stubGlobal('navigator', {
      hardwareConcurrency: 8,
      deviceMemory: 16,
    });
    expect(canRunGiga()).toBe(true);
  });

  it('returns false for low core count (< 4)', () => {
    vi.stubGlobal('navigator', {
      hardwareConcurrency: 2,
      deviceMemory: 16,
    });
    expect(canRunGiga()).toBe(false);
  });

  it('returns false for low memory (< 4GB)', () => {
    vi.stubGlobal('navigator', {
      hardwareConcurrency: 8,
      deviceMemory: 2,
    });
    expect(canRunGiga()).toBe(false);
  });

  it('returns true when deviceMemory is undefined (non-Chromium)', () => {
    vi.stubGlobal('navigator', {
      hardwareConcurrency: 4,
    });
    expect(canRunGiga()).toBe(true);
  });

  it('returns false when hardwareConcurrency is undefined', () => {
    vi.stubGlobal('navigator', {});
    expect(canRunGiga()).toBe(false);
  });

  it('returns true at the threshold (exactly 4 cores, exactly 4GB)', () => {
    vi.stubGlobal('navigator', {
      hardwareConcurrency: 4,
      deviceMemory: 4,
    });
    expect(canRunGiga()).toBe(true);
  });
});

describe('supportsAudioWorklet', () => {
  it('returns true when AudioContext with audioWorklet is available', () => {
    function MockAudioContext() {}
    MockAudioContext.prototype = { audioWorklet: {} } as unknown as AudioContext;
    vi.stubGlobal('AudioContext', MockAudioContext);
    expect(supportsAudioWorklet()).toBe(true);
  });

  it('returns false when AudioContext is not available', () => {
    vi.stubGlobal('AudioContext', undefined);
    expect(supportsAudioWorklet()).toBe(false);
  });
});
