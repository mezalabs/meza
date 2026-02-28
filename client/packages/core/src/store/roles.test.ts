import { beforeEach, describe, expect, it } from 'vitest';
import { useRoleStore } from './roles.ts';

// biome-ignore lint/suspicious/noExplicitAny: test fixture — plain objects standing in for protobuf messages
const role1: any = {
  id: 'r1',
  serverId: 's1',
  name: 'Admin',
  position: 10,
  permissions: 0n,
  color: 0,
};
// biome-ignore lint/suspicious/noExplicitAny: test fixture
const role2: any = {
  id: 'r2',
  serverId: 's1',
  name: 'Mod',
  position: 5,
  permissions: 0n,
  color: 0,
};
// biome-ignore lint/suspicious/noExplicitAny: test fixture
const role3: any = {
  id: 'r3',
  serverId: 's1',
  name: 'Member',
  position: 1,
  permissions: 0n,
  color: 0,
};

beforeEach(() => {
  useRoleStore.setState({ byServer: {}, isLoading: false, error: null });
});

describe('role store', () => {
  it('starts empty', () => {
    expect(useRoleStore.getState().byServer).toEqual({});
  });

  it('setRoles stores and sorts by position descending', () => {
    useRoleStore.getState().setRoles('s1', [role3, role1, role2]);
    const roles = useRoleStore.getState().byServer.s1;

    expect(roles).toHaveLength(3);
    expect(roles?.[0].id).toBe('r1'); // position 10 first
    expect(roles?.[1].id).toBe('r2'); // position 5
    expect(roles?.[2].id).toBe('r3'); // position 1
  });

  it('addRole inserts and maintains sort', () => {
    useRoleStore.getState().setRoles('s1', [role1]);
    useRoleStore.getState().addRole(role2);

    const roles = useRoleStore.getState().byServer.s1;
    expect(roles).toHaveLength(2);
    expect(roles?.[0].id).toBe('r1'); // higher position first
  });

  it('addRole creates server entry if missing', () => {
    useRoleStore.getState().addRole(role1);
    expect(useRoleStore.getState().byServer.s1).toHaveLength(1);
  });

  it('updateRole replaces role data and re-sorts', () => {
    useRoleStore.getState().setRoles('s1', [role1, role2]);
    const updated = { ...role2, name: 'Super Mod', position: 15 };
    useRoleStore.getState().updateRole(updated);

    const roles = useRoleStore.getState().byServer.s1;
    expect(roles?.[0].name).toBe('Super Mod'); // now position 15, first
    expect(roles?.[0].position).toBe(15);
  });

  it('updateRole does nothing for unknown role', () => {
    useRoleStore.getState().setRoles('s1', [role1]);
    useRoleStore
      .getState()
      .updateRole({ id: 'unknown', serverId: 's1' } as never);
    expect(useRoleStore.getState().byServer.s1).toHaveLength(1);
  });

  it('removeRole removes the role', () => {
    useRoleStore.getState().setRoles('s1', [role1, role2]);
    useRoleStore.getState().removeRole('s1', 'r1');

    expect(useRoleStore.getState().byServer.s1).toHaveLength(1);
    expect(useRoleStore.getState().byServer.s1?.[0].id).toBe('r2');
  });

  it('removeRole does nothing for unknown server', () => {
    useRoleStore.getState().removeRole('unknown', 'r1');
    expect(useRoleStore.getState().byServer).toEqual({});
  });

  it('removeServerRoles removes all roles for server', () => {
    useRoleStore.getState().setRoles('s1', [role1, role2]);
    useRoleStore.getState().removeServerRoles('s1');

    expect(useRoleStore.getState().byServer.s1).toBeUndefined();
  });

  it('setLoading updates loading state', () => {
    useRoleStore.getState().setLoading(true);
    expect(useRoleStore.getState().isLoading).toBe(true);
  });

  it('setError sets error and clears loading', () => {
    useRoleStore.getState().setLoading(true);
    useRoleStore.getState().setError('failed');

    expect(useRoleStore.getState().error).toBe('failed');
    expect(useRoleStore.getState().isLoading).toBe(false);
  });

  it('reset clears everything', () => {
    useRoleStore.getState().setRoles('s1', [role1]);
    useRoleStore.getState().setLoading(true);
    useRoleStore.getState().reset();

    const state = useRoleStore.getState();
    expect(state.byServer).toEqual({});
    expect(state.isLoading).toBe(false);
    expect(state.error).toBeNull();
  });
});
