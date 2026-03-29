import { describe, expect, it } from 'vitest';
import { Shell } from './index.ts';

describe('ui', () => {
  it('exports Shell component', () => {
    expect(typeof Shell).toBe('function');
  });
});
