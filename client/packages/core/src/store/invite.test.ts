import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useInviteStore } from './invite.ts';

const mockStorage = new Map<string, string>();

beforeEach(() => {
  mockStorage.clear();
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => mockStorage.get(key) ?? null,
    setItem: (key: string, value: string) => mockStorage.set(key, value),
    removeItem: (key: string) => mockStorage.delete(key),
  });
  useInviteStore.setState({
    pendingCode: null,
    pendingHost: null,
    inviteSecret: null,
    pendingNonce: 0,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('invite store', () => {
  it('setPendingCode stores the code in state and sessionStorage', () => {
    useInviteStore.getState().setPendingCode('abc12345');
    expect(useInviteStore.getState().pendingCode).toBe('abc12345');
    expect(mockStorage.get('meza:pending_invite')).toBe('abc12345');
  });

  it('setPendingCode(null) clears state and sessionStorage', () => {
    useInviteStore.getState().setPendingCode('abc12345');
    useInviteStore.getState().setPendingCode(null);
    expect(useInviteStore.getState().pendingCode).toBeNull();
    expect(mockStorage.has('meza:pending_invite')).toBe(false);
  });

  it('pendingNonce starts at 0 and increments on every setPendingCode', () => {
    expect(useInviteStore.getState().pendingNonce).toBe(0);
    useInviteStore.getState().setPendingCode('abc12345');
    expect(useInviteStore.getState().pendingNonce).toBe(1);
    useInviteStore.getState().setPendingCode('abc12345'); // same value
    expect(useInviteStore.getState().pendingNonce).toBe(2);
    useInviteStore.getState().setPendingCode('def67890');
    expect(useInviteStore.getState().pendingNonce).toBe(3);
    useInviteStore.getState().setPendingCode(null);
    expect(useInviteStore.getState().pendingNonce).toBe(4);
  });

  it('clearPendingCode wipes code, host, and secret but does not bump nonce', () => {
    useInviteStore.getState().setPendingCode('abc12345');
    useInviteStore.getState().setPendingHost('example.org');
    useInviteStore.getState().setInviteSecret('the-secret');
    const beforeNonce = useInviteStore.getState().pendingNonce;

    useInviteStore.getState().clearPendingCode();
    const after = useInviteStore.getState();
    expect(after.pendingCode).toBeNull();
    expect(after.pendingHost).toBeNull();
    expect(after.inviteSecret).toBeNull();
    expect(after.pendingNonce).toBe(beforeNonce);
  });
});
