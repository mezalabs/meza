import { describe, expect, it } from 'vitest';
import { MEZA_VERSION, Shell } from './index.ts';

describe('ui', () => {
  it('exports Shell component', () => {
    expect(typeof Shell).toBe('function');
  });

  it('re-exports MEZA_VERSION from core', () => {
    expect(typeof MEZA_VERSION).toBe('string');
  });
});
