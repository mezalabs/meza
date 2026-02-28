import { beforeEach, describe, expect, it } from 'vitest';
import { useChannelStore } from './channels.ts';

const chan1 = {
  id: 'c1',
  serverId: 's1',
  name: 'general',
  position: 0,
  type: 1,
  topic: '',
} as never;
const chan2 = {
  id: 'c2',
  serverId: 's1',
  name: 'random',
  position: 1,
  type: 1,
  topic: '',
} as never;
const chan3 = {
  id: 'c3',
  serverId: 's2',
  name: 'dev',
  position: 0,
  type: 1,
  topic: '',
} as never;

beforeEach(() => {
  useChannelStore.setState({
    byServer: {},
    isLoading: false,
    error: null,
  });
});

describe('channel store', () => {
  it('starts with empty channels', () => {
    expect(useChannelStore.getState().byServer).toEqual({});
  });

  it('setChannels stores channels keyed by serverId', () => {
    useChannelStore.getState().setChannels('s1', [chan1, chan2]);
    useChannelStore.getState().setChannels('s2', [chan3]);

    const state = useChannelStore.getState();
    expect(state.byServer.s1).toHaveLength(2);
    expect(state.byServer.s2).toHaveLength(1);
  });

  it('setChannels sorts by position', () => {
    const unsorted = [
      {
        id: 'c2',
        serverId: 's1',
        name: 'random',
        position: 2,
        type: 1,
        topic: '',
      } as never,
      {
        id: 'c1',
        serverId: 's1',
        name: 'general',
        position: 0,
        type: 1,
        topic: '',
      } as never,
      {
        id: 'c3',
        serverId: 's1',
        name: 'dev',
        position: 1,
        type: 1,
        topic: '',
      } as never,
    ];
    useChannelStore.getState().setChannels('s1', unsorted);

    const channels = useChannelStore.getState().byServer.s1;
    expect(channels[0].id).toBe('c1');
    expect(channels[1].id).toBe('c3');
    expect(channels[2].id).toBe('c2');
  });

  it('addChannel appends to correct server', () => {
    useChannelStore.getState().setChannels('s1', [chan1]);
    useChannelStore.getState().addChannel(chan2);

    expect(useChannelStore.getState().byServer.s1).toHaveLength(2);
  });

  it('addChannel creates server list if missing', () => {
    useChannelStore.getState().addChannel(chan3);

    expect(useChannelStore.getState().byServer.s2).toHaveLength(1);
  });

  it('setError sets error and clears loading', () => {
    useChannelStore.getState().setLoading(true);
    useChannelStore.getState().setError('Failed');

    const state = useChannelStore.getState();
    expect(state.error).toBe('Failed');
    expect(state.isLoading).toBe(false);
  });
});
