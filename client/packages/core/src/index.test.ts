import { describe, expect, it } from 'vitest';
import { LOBBY_SERVER_ID } from './index.ts';

describe('core', () => {
  it('exports LOBBY_SERVER_ID as a string', () => {
    expect(typeof LOBBY_SERVER_ID).toBe('string');
    expect(LOBBY_SERVER_ID.length).toBeGreaterThan(0);
  });
});
