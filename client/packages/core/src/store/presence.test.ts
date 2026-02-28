import { beforeEach, describe, expect, it } from 'vitest';
import { usePresenceStore } from './presence.ts';

beforeEach(() => {
  usePresenceStore.setState({ byUser: {} });
});

describe('presence store', () => {
  it('starts with empty byUser', () => {
    expect(usePresenceStore.getState().byUser).toEqual({});
  });

  it('setPresence adds user presence', () => {
    usePresenceStore.getState().setPresence('u1', 1 as never, 'online');
    const state = usePresenceStore.getState();
    expect(state.byUser.u1).toBeDefined();
    expect(state.byUser.u1?.statusText).toBe('online');
  });

  it('setPresence overwrites existing presence', () => {
    usePresenceStore.getState().setPresence('u1', 1 as never, 'hello');
    usePresenceStore.getState().setPresence('u1', 2 as never, 'away');

    expect(usePresenceStore.getState().byUser.u1?.statusText).toBe('away');
  });

  it('setBulkPresence sets multiple users', () => {
    usePresenceStore.getState().setBulkPresence([
      { userId: 'u1', status: 1 as never, statusText: 'online' },
      { userId: 'u2', status: 2 as never, statusText: 'idle' },
    ]);

    const state = usePresenceStore.getState();
    expect(Object.keys(state.byUser)).toHaveLength(2);
    expect(state.byUser.u1?.statusText).toBe('online');
    expect(state.byUser.u2?.statusText).toBe('idle');
  });

  it('reset clears all presence', () => {
    usePresenceStore.getState().setPresence('u1', 1 as never, 'online');
    usePresenceStore.getState().reset();

    expect(usePresenceStore.getState().byUser).toEqual({});
  });
});
