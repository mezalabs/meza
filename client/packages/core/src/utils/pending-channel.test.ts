import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearPendingChannel,
  consumePendingChannel,
  getPendingChannel,
  setPendingChannel,
} from './pending-channel.ts';

beforeEach(() => {
  clearPendingChannel();
});

describe('pending-channel', () => {
  it('returns null when no channel is buffered', () => {
    expect(getPendingChannel()).toBeNull();
    expect(consumePendingChannel()).toBeNull();
  });

  it('stores and returns the channel id', () => {
    setPendingChannel('chan-123');
    expect(getPendingChannel()).toBe('chan-123');
  });

  it('consumePendingChannel returns the id and clears the buffer', () => {
    setPendingChannel('chan-123');
    expect(consumePendingChannel()).toBe('chan-123');
    expect(getPendingChannel()).toBeNull();
    expect(consumePendingChannel()).toBeNull();
  });

  it('last set wins when called multiple times before consumption', () => {
    setPendingChannel('chan-a');
    setPendingChannel('chan-b');
    setPendingChannel('chan-c');
    expect(consumePendingChannel()).toBe('chan-c');
  });

  it('clearPendingChannel wipes the buffer without returning a value', () => {
    setPendingChannel('chan-123');
    clearPendingChannel();
    expect(getPendingChannel()).toBeNull();
  });
});
