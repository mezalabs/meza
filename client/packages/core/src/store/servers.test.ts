import { beforeEach, describe, expect, it } from 'vitest';
import { useServerStore } from './servers.ts';

const server1 = {
  id: 's1',
  name: 'Test Server',
  iconUrl: '',
  ownerId: 'u1',
} as never;
const server2 = {
  id: 's2',
  name: 'Other Server',
  iconUrl: '',
  ownerId: 'u2',
} as never;

beforeEach(() => {
  useServerStore.setState({
    servers: {},
    isLoading: false,
    error: null,
  });
});

describe('server store', () => {
  it('starts with empty servers', () => {
    expect(useServerStore.getState().servers).toEqual({});
  });

  it('setServers replaces all servers', () => {
    useServerStore.getState().setServers([server1, server2]);
    const state = useServerStore.getState();

    expect(Object.keys(state.servers)).toHaveLength(2);
    expect(state.servers.s1).toEqual(server1);
    expect(state.servers.s2).toEqual(server2);
    expect(state.isLoading).toBe(false);
  });

  it('setServers clears previous servers', () => {
    useServerStore.getState().setServers([server1, server2]);
    useServerStore.getState().setServers([server1]);

    expect(Object.keys(useServerStore.getState().servers)).toHaveLength(1);
    expect(useServerStore.getState().servers.s2).toBeUndefined();
  });

  it('addServer adds without removing existing', () => {
    useServerStore.getState().setServers([server1]);
    useServerStore.getState().addServer(server2);

    const state = useServerStore.getState();
    expect(Object.keys(state.servers)).toHaveLength(2);
    expect(state.servers.s1).toEqual(server1);
    expect(state.servers.s2).toEqual(server2);
  });

  it('setLoading updates loading state', () => {
    useServerStore.getState().setLoading(true);
    expect(useServerStore.getState().isLoading).toBe(true);
  });

  it('setError sets error and clears loading', () => {
    useServerStore.getState().setLoading(true);
    useServerStore.getState().setError('Failed');

    const state = useServerStore.getState();
    expect(state.error).toBe('Failed');
    expect(state.isLoading).toBe(false);
  });
});
