import { describe, expect, it } from 'vitest';
import { MEZA_VERSION } from './index.ts';

describe('core', () => {
  it('exports MEZA_VERSION as a string', () => {
    expect(typeof MEZA_VERSION).toBe('string');
    expect(MEZA_VERSION.length).toBeGreaterThan(0);
  });
});
