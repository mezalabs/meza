import { beforeEach, describe, expect, it, vi } from 'vitest';

// Module-level mock state, mutated per test.
const tilingState = {
  focusedPaneId: 'pane-1' as const,
  setPaneContent: vi.fn(),
};
let authUserId: string | undefined;
let authIsAuthenticated = true;
let sessionReady = true;
const setPendingPushNav = vi.fn();

vi.mock('@meza/core', () => ({
  isSessionReady: () => sessionReady,
  setPendingPushNav: (data: unknown) => setPendingPushNav(data),
  useAuthStore: {
    getState: () => ({
      isAuthenticated: authIsAuthenticated,
      user: authUserId ? { id: authUserId } : undefined,
    }),
  },
}));

vi.mock('@meza/ui', () => ({
  useTilingStore: {
    getState: () => tilingState,
  },
}));

import {
  navigateFromPush,
  navigateToChannel,
  navigateToDMConversation,
} from './navigate.ts';

describe('navigateFromPush — cross-account filter', () => {
  beforeEach(() => {
    tilingState.setPaneContent.mockReset();
    setPendingPushNav.mockReset();
    authUserId = 'u_current';
    authIsAuthenticated = true;
    sessionReady = true;
  });

  it('routes to channel pane when kind != dm and ids match', () => {
    navigateFromPush({
      kind: 'message',
      channel_id: 'c_42',
      user_id: 'u_current',
    });
    expect(tilingState.setPaneContent).toHaveBeenCalledTimes(1);
    expect(tilingState.setPaneContent).toHaveBeenCalledWith('pane-1', {
      type: 'channel',
      channelId: 'c_42',
    });
    expect(setPendingPushNav).not.toHaveBeenCalled();
  });

  it('routes to DM pane when kind === "dm" and ids match', () => {
    navigateFromPush({
      kind: 'dm',
      channel_id: 'c_dm',
      user_id: 'u_current',
    });
    expect(tilingState.setPaneContent).toHaveBeenCalledTimes(1);
    expect(tilingState.setPaneContent).toHaveBeenCalledWith('pane-1', {
      type: 'dm',
      conversationId: 'c_dm',
    });
  });

  it('drops when user_id mismatches the current session', () => {
    navigateFromPush({
      kind: 'dm',
      channel_id: 'c_dm',
      user_id: 'u_other',
    });
    expect(tilingState.setPaneContent).not.toHaveBeenCalled();
    expect(setPendingPushNav).not.toHaveBeenCalled();
  });

  it('drops when user_id is missing (forged or stripped payload)', () => {
    navigateFromPush({
      kind: 'dm',
      channel_id: 'c_dm',
    });
    expect(tilingState.setPaneContent).not.toHaveBeenCalled();
    expect(setPendingPushNav).not.toHaveBeenCalled();
  });

  it('drops when channel_id is missing', () => {
    navigateFromPush({
      kind: 'dm',
      user_id: 'u_current',
    } as Parameters<typeof navigateFromPush>[0]);
    expect(tilingState.setPaneContent).not.toHaveBeenCalled();
    expect(setPendingPushNav).not.toHaveBeenCalled();
  });

  it('drops when not authenticated (no buffer either)', () => {
    authIsAuthenticated = false;
    navigateFromPush({
      kind: 'dm',
      channel_id: 'c_dm',
      user_id: 'u_current',
    });
    expect(tilingState.setPaneContent).not.toHaveBeenCalled();
    expect(setPendingPushNav).not.toHaveBeenCalled();
  });

  it('buffers when authenticated but session is not ready', () => {
    sessionReady = false;
    const intent = {
      kind: 'dm',
      channel_id: 'c_dm',
      user_id: 'u_current',
    };
    navigateFromPush(intent);
    expect(tilingState.setPaneContent).not.toHaveBeenCalled();
    expect(setPendingPushNav).toHaveBeenCalledWith(intent);
  });

  it('buffers when currentUserId not yet hydrated (cold-start window)', () => {
    authUserId = undefined;
    const intent = {
      kind: 'dm',
      channel_id: 'c_dm',
      user_id: 'u_current',
    };
    navigateFromPush(intent);
    expect(tilingState.setPaneContent).not.toHaveBeenCalled();
    expect(setPendingPushNav).toHaveBeenCalledWith(intent);
  });

  it('falls back to channel pane for unknown kind values', () => {
    navigateFromPush({
      kind: 'unknown_future_kind',
      channel_id: 'c_42',
      user_id: 'u_current',
    });
    expect(tilingState.setPaneContent).toHaveBeenCalledWith('pane-1', {
      type: 'channel',
      channelId: 'c_42',
    });
  });
});

describe('navigateToChannel / navigateToDMConversation', () => {
  beforeEach(() => {
    tilingState.setPaneContent.mockReset();
  });

  it('navigateToChannel sets channel pane content on focused pane', () => {
    navigateToChannel('c_42');
    expect(tilingState.setPaneContent).toHaveBeenCalledWith('pane-1', {
      type: 'channel',
      channelId: 'c_42',
    });
  });

  it('navigateToDMConversation sets dm pane content on focused pane', () => {
    navigateToDMConversation('c_dm');
    expect(tilingState.setPaneContent).toHaveBeenCalledWith('pane-1', {
      type: 'dm',
      conversationId: 'c_dm',
    });
  });
});
