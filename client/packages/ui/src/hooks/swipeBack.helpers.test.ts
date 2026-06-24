import { describe, expect, it } from 'vitest';
import {
  commitDuration,
  computeVelocity,
  shouldCommit,
} from './swipeBack.helpers.ts';

describe('computeVelocity', () => {
  it('returns 0 with fewer than two samples', () => {
    expect(computeVelocity([])).toBe(0);
    expect(computeVelocity([{ x: 10, t: 0 }])).toBe(0);
  });

  it('computes px/ms over the sampled span', () => {
    expect(
      computeVelocity([
        { x: 0, t: 0 },
        { x: 50, t: 100 },
      ]),
    ).toBeCloseTo(0.5);
  });

  it('returns 0 when the time delta is zero', () => {
    expect(
      computeVelocity([
        { x: 0, t: 5 },
        { x: 10, t: 5 },
      ]),
    ).toBe(0);
  });

  it('only averages over the recent velocity window', () => {
    // Earliest sample is outside the 80ms window and must be ignored.
    expect(
      computeVelocity([
        { x: 0, t: 0 },
        { x: 10, t: 50 },
        { x: 100, t: 200 },
      ]),
    ).toBeCloseTo((100 - 10) / (200 - 50));
  });
});

describe('shouldCommit', () => {
  const width = 400; // minDistance = max(48, 0.12*400=48) = 48

  it('never commits below the minimum travel, however fast', () => {
    expect(shouldCommit({ dx: 40, width, velocity: 5 })).toBe(false);
  });

  it('commits on distance past the 30% threshold', () => {
    expect(shouldCommit({ dx: 200, width, velocity: 0 })).toBe(true);
  });

  it('commits a short, fast flick once past the minimum travel', () => {
    expect(shouldCommit({ dx: 60, width, velocity: 0.6 })).toBe(true);
  });

  it('does not commit a short, slow drag', () => {
    expect(shouldCommit({ dx: 60, width, velocity: 0.2 })).toBe(false);
  });

  it('never commits with a zero-width element', () => {
    expect(shouldCommit({ dx: 999, width: 0, velocity: 9 })).toBe(false);
  });
});

describe('commitDuration', () => {
  it('is instant under reduced motion', () => {
    expect(
      commitDuration({ remainingPx: 300, velocity: 1, reducedMotion: true }),
    ).toBe(0);
  });

  it('clamps a fast flick to the minimum duration', () => {
    expect(
      commitDuration({ remainingPx: 100, velocity: 2, reducedMotion: false }),
    ).toBe(140);
  });

  it('clamps a near-stationary release to the maximum duration', () => {
    expect(
      commitDuration({ remainingPx: 300, velocity: 0, reducedMotion: false }),
    ).toBe(320);
  });

  it('scales between the bounds for a mid-speed gesture', () => {
    expect(
      commitDuration({ remainingPx: 300, velocity: 1, reducedMotion: false }),
    ).toBe(300);
  });

  it('uses the absolute velocity (direction-agnostic)', () => {
    expect(
      commitDuration({ remainingPx: 300, velocity: -1, reducedMotion: false }),
    ).toBe(300);
  });
});
