import { beforeEach, describe, expect, it } from 'vitest';
import { usePinStore } from './pins.ts';

const pin1 = { message: { id: 'm1', channelId: 'c1' }, pinnedAt: {} } as never;
const pin2 = { message: { id: 'm2', channelId: 'c1' }, pinnedAt: {} } as never;

beforeEach(() => {
  usePinStore.setState({
    byChannel: {},
    hasMore: {},
    isLoading: {},
    error: {},
    pinnedIds: {},
  });
});

describe('pin store', () => {
  it('starts empty', () => {
    expect(usePinStore.getState().byChannel).toEqual({});
  });

  it('setPinnedMessages stores pins and builds pinnedIds', () => {
    usePinStore.getState().setPinnedMessages('c1', [pin1, pin2], true);

    const state = usePinStore.getState();
    expect(state.byChannel.c1).toHaveLength(2);
    expect(state.hasMore.c1).toBe(true);
    expect(state.pinnedIds.c1?.m1).toBe(true);
    expect(state.pinnedIds.c1?.m2).toBe(true);
  });

  it('appendPinnedMessages merges with existing', () => {
    usePinStore.getState().setPinnedMessages('c1', [pin1], true);
    usePinStore.getState().appendPinnedMessages('c1', [pin2], false);

    const state = usePinStore.getState();
    expect(state.byChannel.c1).toHaveLength(2);
    expect(state.hasMore.c1).toBe(false);
    expect(state.pinnedIds.c1?.m1).toBe(true);
    expect(state.pinnedIds.c1?.m2).toBe(true);
  });

  it('addPin prepends to list', () => {
    usePinStore.getState().setPinnedMessages('c1', [pin1], false);
    usePinStore.getState().addPin('c1', pin2);

    const state = usePinStore.getState();
    expect(state.byChannel.c1).toHaveLength(2);
    expect(state.byChannel.c1[0].message?.id).toBe('m2'); // prepended
    expect(state.pinnedIds.c1?.m2).toBe(true); // new pin added
    expect(state.pinnedIds.c1?.m1).toBe(true); // existing pin preserved
  });

  it('addPin deduplicates by message id', () => {
    usePinStore.getState().setPinnedMessages('c1', [pin1], false);
    usePinStore.getState().addPin('c1', pin1);

    expect(usePinStore.getState().byChannel.c1).toHaveLength(1);
  });

  it('addPin creates channel entry if missing', () => {
    usePinStore.getState().addPin('c1', pin1);
    expect(usePinStore.getState().byChannel.c1).toHaveLength(1);
  });

  it('removePin removes by messageId', () => {
    usePinStore.getState().setPinnedMessages('c1', [pin1, pin2], false);
    usePinStore.getState().removePin('c1', 'm1');

    const state = usePinStore.getState();
    expect(state.byChannel.c1).toHaveLength(1);
    expect(state.byChannel.c1?.[0].message?.id).toBe('m2');
    expect(state.pinnedIds.c1?.m1).toBeUndefined();
  });

  it('removePin does nothing for unknown channel', () => {
    usePinStore.getState().removePin('unknown', 'm1');
    expect(usePinStore.getState().byChannel).toEqual({});
  });

  it('setLoading tracks per-channel loading', () => {
    usePinStore.getState().setLoading('c1', true);
    expect(usePinStore.getState().isLoading.c1).toBe(true);

    usePinStore.getState().setLoading('c1', false);
    expect(usePinStore.getState().isLoading.c1).toBeUndefined();
  });

  it('setError tracks per-channel error and clears loading', () => {
    usePinStore.getState().setLoading('c1', true);
    usePinStore.getState().setError('c1', 'failed');

    expect(usePinStore.getState().error.c1).toBe('failed');
    expect(usePinStore.getState().isLoading.c1).toBeUndefined();
  });

  it('setError with null clears error', () => {
    usePinStore.getState().setError('c1', 'old error');
    usePinStore.getState().setError('c1', null);

    expect(usePinStore.getState().error.c1).toBeUndefined();
  });

  it('reset clears everything', () => {
    usePinStore.getState().setPinnedMessages('c1', [pin1], true);
    usePinStore.getState().reset();

    const state = usePinStore.getState();
    expect(state.byChannel).toEqual({});
    expect(state.hasMore).toEqual({});
    expect(state.pinnedIds).toEqual({});
  });
});
