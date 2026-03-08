import { beforeEach, describe, expect, it } from 'vitest';
import { useMemberStore } from './members.ts';

// biome-ignore lint/suspicious/noExplicitAny: test fixture — plain objects standing in for protobuf messages
const member1: any = {
  userId: 'u1',
  serverId: 's1',
  roleIds: ['r1', 'r2'],
  nickname: '',
};
// biome-ignore lint/suspicious/noExplicitAny: test fixture
const member2: any = {
  userId: 'u2',
  serverId: 's1',
  roleIds: ['r1'],
  nickname: '',
};
// biome-ignore lint/suspicious/noExplicitAny: test fixture
const member3: any = {
  userId: 'u3',
  serverId: 's1',
  roleIds: [],
  nickname: '',
};

beforeEach(() => {
  useMemberStore.setState({ byInstance: {}, byServer: {}, isLoading: false, error: null });
});

describe('member store', () => {
  it('starts empty', () => {
    expect(useMemberStore.getState().byServer).toEqual({});
  });

  it('setMembers stores members for server', () => {
    useMemberStore.getState().setMembers('s1', [member1, member2]);
    expect(useMemberStore.getState().byServer.s1).toHaveLength(2);
  });

  it('addMember adds to existing list', () => {
    useMemberStore.getState().setMembers('s1', [member1]);
    useMemberStore.getState().addMember(member2);

    expect(useMemberStore.getState().byServer.s1).toHaveLength(2);
  });

  it('addMember prevents duplicates', () => {
    useMemberStore.getState().setMembers('s1', [member1]);
    useMemberStore.getState().addMember(member1);

    expect(useMemberStore.getState().byServer.s1).toHaveLength(1);
  });

  it('addMember creates server entry if missing', () => {
    useMemberStore.getState().addMember(member1);
    expect(useMemberStore.getState().byServer.s1).toHaveLength(1);
  });

  it('updateMember replaces member data', () => {
    useMemberStore.getState().setMembers('s1', [member1]);
    const updated = { ...member1, nickname: 'Alice' };
    useMemberStore.getState().updateMember(updated);

    expect(useMemberStore.getState().byServer.s1?.[0].nickname).toBe('Alice');
  });

  it('updateMember does nothing for unknown member', () => {
    useMemberStore.getState().setMembers('s1', [member1]);
    useMemberStore
      .getState()
      .updateMember({ userId: 'unknown', serverId: 's1' } as never);
    expect(useMemberStore.getState().byServer.s1).toHaveLength(1);
  });

  it('removeMember removes by userId', () => {
    useMemberStore.getState().setMembers('s1', [member1, member2]);
    useMemberStore.getState().removeMember('s1', 'u1');

    expect(useMemberStore.getState().byServer.s1).toHaveLength(1);
    expect(useMemberStore.getState().byServer.s1?.[0].userId).toBe('u2');
  });

  it('removeMember does nothing for unknown server', () => {
    useMemberStore.getState().removeMember('unknown', 'u1');
    expect(useMemberStore.getState().byServer).toEqual({});
  });

  it('stripRoleFromAll removes roleId from all members', () => {
    useMemberStore.getState().setMembers('s1', [member1, member2, member3]);
    useMemberStore.getState().stripRoleFromAll('s1', 'r1');

    const members = useMemberStore.getState().byServer.s1;
    expect(members?.[0].roleIds).toEqual(['r2']); // u1 had r1,r2 -> r2
    expect(members?.[1].roleIds).toEqual([]); // u2 had r1 -> empty
    expect(members?.[2].roleIds).toEqual([]); // u3 had none
  });

  it('stripRoleFromAll does nothing for unknown server', () => {
    useMemberStore.getState().stripRoleFromAll('unknown', 'r1');
    expect(useMemberStore.getState().byServer).toEqual({});
  });

  it('setLoading updates loading state', () => {
    useMemberStore.getState().setLoading(true);
    expect(useMemberStore.getState().isLoading).toBe(true);
  });

  it('setError sets error and clears loading', () => {
    useMemberStore.getState().setLoading(true);
    useMemberStore.getState().setError('failed');

    expect(useMemberStore.getState().error).toBe('failed');
    expect(useMemberStore.getState().isLoading).toBe(false);
  });

  it('reset clears everything', () => {
    useMemberStore.getState().setMembers('s1', [member1]);
    useMemberStore.getState().reset();

    const state = useMemberStore.getState();
    expect(state.byServer).toEqual({});
    expect(state.isLoading).toBe(false);
    expect(state.error).toBeNull();
  });
});
