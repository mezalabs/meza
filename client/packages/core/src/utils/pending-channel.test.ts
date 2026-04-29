import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearPendingPushNav,
  consumePendingPushNav,
  setPendingPushNav,
} from './pending-channel.ts';

beforeEach(() => {
  clearPendingPushNav();
});

describe('pending-push-nav', () => {
  it('consume returns null when nothing is buffered', () => {
    expect(consumePendingPushNav()).toBeNull();
  });

  it('set then consume returns the value and clears the buffer', () => {
    const intent = {
      kind: 'dm',
      channel_id: 'chan-123',
      user_id: 'u_recipient',
    };
    setPendingPushNav(intent);
    expect(consumePendingPushNav()).toEqual(intent);
    expect(consumePendingPushNav()).toBeNull();
  });

  it('last set wins when called multiple times before consume', () => {
    setPendingPushNav({ channel_id: 'chan-a' });
    setPendingPushNav({ channel_id: 'chan-b' });
    setPendingPushNav({ channel_id: 'chan-c', kind: 'dm', user_id: 'u' });
    expect(consumePendingPushNav()).toEqual({
      channel_id: 'chan-c',
      kind: 'dm',
      user_id: 'u',
    });
  });

  it('clearPendingPushNav discards a buffered value without reading it', () => {
    setPendingPushNav({ channel_id: 'chan-123' });
    clearPendingPushNav();
    expect(consumePendingPushNav()).toBeNull();
  });
});
