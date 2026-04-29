import { beforeEach, describe, expect, it, vi } from 'vitest';

// Module-level mock state, mutated per test.
const tilingState = {
  focusedPaneId: 'pane-1' as const,
  setPaneContent: vi.fn(),
};
let authUserId: string | undefined;

vi.mock('@meza/core', () => ({
  useAuthStore: {
    getState: () => ({ user: authUserId ? { id: authUserId } : undefined }),
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
    authUserId = 'u_current';
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
  });

  it('drops when user_id is missing (forged or stripped payload)', () => {
    navigateFromPush({
      kind: 'dm',
      channel_id: 'c_dm',
    });
    expect(tilingState.setPaneContent).not.toHaveBeenCalled();
  });

  it('drops when channel_id is missing', () => {
    navigateFromPush({
      kind: 'dm',
      user_id: 'u_current',
    });
    expect(tilingState.setPaneContent).not.toHaveBeenCalled();
  });

  it('drops when no user is signed in (cold-start window)', () => {
    authUserId = undefined;
    navigateFromPush({
      kind: 'dm',
      channel_id: 'c_dm',
      user_id: 'u_current',
    });
    expect(tilingState.setPaneContent).not.toHaveBeenCalled();
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
