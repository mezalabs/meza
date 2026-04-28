import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearPendingChannel,
  consumePendingChannel,
  setPendingChannel,
} from './pending-channel.ts';

beforeEach(() => {
  clearPendingChannel();
});

describe('pending-channel', () => {
  it('consume returns null when nothing is buffered', () => {
    expect(consumePendingChannel()).toBeNull();
  });

  it('set then consume returns the value and clears the buffer', () => {
    setPendingChannel('chan-123');
    expect(consumePendingChannel()).toBe('chan-123');
    expect(consumePendingChannel()).toBeNull();
  });

  it('last set wins when called multiple times before consume', () => {
    setPendingChannel('chan-a');
    setPendingChannel('chan-b');
    setPendingChannel('chan-c');
    expect(consumePendingChannel()).toBe('chan-c');
  });

  it('clearPendingChannel discards a buffered value without reading it', () => {
    setPendingChannel('chan-123');
    clearPendingChannel();
    expect(consumePendingChannel()).toBeNull();
  });
});
