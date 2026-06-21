import { create } from '@bufbuild/protobuf';
import {
  ChannelSchema,
  ChannelType,
  DMChannelSchema,
  UserSchema,
} from '@meza/gen/meza/v1/models_pb.ts';
import { PresenceStatus } from '@meza/gen/meza/v1/presence_pb.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoredUser } from '../store/auth.ts';
import { useBlockStore } from '../store/blocks.ts';
import { useChannelStore } from '../store/channels.ts';
import { useDMStore } from '../store/dms.ts';
import { useNotificationSettingsStore } from '../store/notificationSettings.ts';
import { usePresenceStore } from '../store/presence.ts';
import { useUsersStore } from '../store/users.ts';
import {
  buildDesktopNotification,
  maybeShowDesktopNotification,
} from './desktop-notifier.ts';

describe('buildDesktopNotification', () => {
  it('1-on-1 DM uses the sender as the title', () => {
    expect(
      buildDesktopNotification({
        channelId: 'c1',
        recipientUserId: 'me',
        isMention: false,
        isDM: true,
        senderName: 'Bob',
      }),
    ).toEqual({
      title: 'Bob',
      body: 'sent you a message',
      data: { channelId: 'c1', kind: 'dm', userId: 'me' },
    });
  });

  it('DM mention switches the body wording', () => {
    expect(
      buildDesktopNotification({
        channelId: 'c1',
        recipientUserId: 'me',
        isMention: true,
        isDM: true,
        senderName: 'Bob',
      }).body,
    ).toBe('mentioned you');
  });

  it('group DM uses the group name as title with the sender in the body', () => {
    expect(
      buildDesktopNotification({
        channelId: 'c1',
        recipientUserId: 'me',
        isMention: false,
        isDM: true,
        senderName: 'Bob',
        groupName: 'Squad',
      }),
    ).toEqual({
      title: 'Squad',
      body: 'Bob sent a message',
      data: { channelId: 'c1', kind: 'dm', userId: 'me' },
    });
  });

  it('server channel uses #channel as the title', () => {
    expect(
      buildDesktopNotification({
        channelId: 'c1',
        recipientUserId: 'me',
        isMention: false,
        isDM: false,
        senderName: 'Bob',
        channelName: 'general',
      }),
    ).toEqual({
      title: '#general',
      body: 'Bob sent a message',
      data: { channelId: 'c1', kind: 'channel', userId: 'me' },
    });
  });

  it('server channel mention names the sender in the body', () => {
    expect(
      buildDesktopNotification({
        channelId: 'c1',
        recipientUserId: 'me',
        isMention: true,
        isDM: false,
        senderName: 'Bob',
        channelName: 'general',
      }).body,
    ).toBe('Bob mentioned you');
  });

  it('falls back to the sender when the channel name is unknown', () => {
    expect(
      buildDesktopNotification({
        channelId: 'c1',
        recipientUserId: 'me',
        isMention: false,
        isDM: false,
        senderName: 'Bob',
      }).title,
    ).toBe('Bob');
  });

  it('carries the recipient (not the sender) in data.userId for the deep link', () => {
    // user_id must equal the signed-in user so the cross-account tap filter
    // in navigateFromPush passes — see DesktopNotificationData docs.
    expect(
      buildDesktopNotification({
        channelId: 'c1',
        recipientUserId: 'me',
        isMention: false,
        isDM: true,
        senderName: 'Bob',
      }).data.userId,
    ).toBe('me');
  });
});

function makeStoredUser(p: Partial<StoredUser> & { id: string }): StoredUser {
  return {
    id: p.id,
    username: p.username ?? 'user',
    displayName: p.displayName ?? '',
    avatarUrl: '',
    emojiScale: 1,
    bio: '',
    pronouns: '',
    bannerUrl: '',
    themeColorPrimary: '',
    themeColorSecondary: '',
    simpleMode: false,
    dmPrivacy: '',
    friendRequestPrivacy: '',
    profilePrivacy: '',
    connections: [],
    createdAt: '',
  };
}

describe('maybeShowDesktopNotification', () => {
  let show: ReturnType<typeof vi.fn>;

  // Defaults: a DM from Bob (u2) to me, no reconnect grace.
  const base = {
    channelId: 'c1',
    authorId: 'u2',
    isMention: false,
    isDM: true,
    reconnectGraceUntil: 0,
    currentUserId: 'me',
  };

  beforeEach(() => {
    show = vi.fn();
    // Electron present; window hidden (the "should fire" baseline).
    vi.stubGlobal('window', { electronAPI: { notifications: { show } } });
    vi.stubGlobal('document', {
      visibilityState: 'hidden',
      hasFocus: () => false,
    });

    // Permissive store defaults.
    usePresenceStore.setState({ myStatus: PresenceStatus.ONLINE });
    useBlockStore.setState({ blockedUsers: [], blockedUserIds: {} });
    useNotificationSettingsStore.setState({ badgeMode: 'all' });
    useUsersStore.setState({
      profiles: { u2: makeStoredUser({ id: 'u2', displayName: 'Bob' }) },
      profileFetchedAt: {},
    });
    useDMStore.setState({ dmChannels: [] });
    useChannelStore.getState().reset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fires a native notification when the window is hidden', () => {
    maybeShowDesktopNotification(base);
    expect(show).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenCalledWith('Bob', 'sent you a message', {
      channelId: 'c1',
      kind: 'dm',
      userId: 'me',
    });
  });

  it('does nothing when electronAPI is absent (non-Electron)', () => {
    vi.stubGlobal('window', {});
    maybeShowDesktopNotification(base);
    expect(show).not.toHaveBeenCalled();
  });

  it('suppresses while the window is visible and focused', () => {
    vi.stubGlobal('document', {
      visibilityState: 'visible',
      hasFocus: () => true,
    });
    maybeShowDesktopNotification(base);
    expect(show).not.toHaveBeenCalled();
  });

  it('fires when visible but unfocused (background window)', () => {
    vi.stubGlobal('document', {
      visibilityState: 'visible',
      hasFocus: () => false,
    });
    maybeShowDesktopNotification(base);
    expect(show).toHaveBeenCalledTimes(1);
  });

  it('suppresses within the reconnect grace window', () => {
    maybeShowDesktopNotification({
      ...base,
      reconnectGraceUntil: Date.now() + 60_000,
    });
    expect(show).not.toHaveBeenCalled();
  });

  it('suppresses in Do Not Disturb', () => {
    usePresenceStore.setState({ myStatus: PresenceStatus.DND });
    maybeShowDesktopNotification(base);
    expect(show).not.toHaveBeenCalled();
  });

  it('suppresses for a blocked author', () => {
    useBlockStore.setState({ blockedUsers: [], blockedUserIds: { u2: true } });
    maybeShowDesktopNotification(base);
    expect(show).not.toHaveBeenCalled();
  });

  it('suppresses everything when badgeMode is off', () => {
    useNotificationSettingsStore.setState({ badgeMode: 'off' });
    maybeShowDesktopNotification(base);
    expect(show).not.toHaveBeenCalled();
  });

  it('mentions_dms: suppresses a regular channel message', () => {
    useNotificationSettingsStore.setState({ badgeMode: 'mentions_dms' });
    maybeShowDesktopNotification({ ...base, isDM: false, isMention: false });
    expect(show).not.toHaveBeenCalled();
  });

  it('mentions_dms: still fires for a DM', () => {
    useNotificationSettingsStore.setState({ badgeMode: 'mentions_dms' });
    maybeShowDesktopNotification(base);
    expect(show).toHaveBeenCalledTimes(1);
  });

  it('resolves a server channel name from the channel store', () => {
    useChannelStore
      .getState()
      .setChannels('s1', [
        create(ChannelSchema, { id: 'c1', serverId: 's1', name: 'general' }),
      ]);
    maybeShowDesktopNotification({ ...base, isDM: false });
    expect(show).toHaveBeenCalledWith('#general', 'Bob sent a message', {
      channelId: 'c1',
      kind: 'channel',
      userId: 'me',
    });
  });

  it('resolves a group DM name from the DM store', () => {
    useDMStore.setState({
      dmChannels: [
        create(DMChannelSchema, {
          channel: create(ChannelSchema, {
            id: 'c1',
            type: ChannelType.GROUP_DM,
            name: 'Squad',
          }),
          participants: [
            create(UserSchema, { id: 'me', username: 'me', displayName: 'Me' }),
            create(UserSchema, {
              id: 'u2',
              username: 'bob',
              displayName: 'Bob',
            }),
          ],
        }),
      ],
    });
    maybeShowDesktopNotification(base);
    expect(show).toHaveBeenCalledWith('Squad', 'Bob sent a message', {
      channelId: 'c1',
      kind: 'dm',
      userId: 'me',
    });
  });

  it('falls back to a DM participant name when the author is not yet in the users store', () => {
    // Brand-new DM: author absent from the users store, present in participants.
    useUsersStore.setState({ profiles: {}, profileFetchedAt: {} });
    useDMStore.setState({
      dmChannels: [
        create(DMChannelSchema, {
          channel: create(ChannelSchema, { id: 'c1', type: ChannelType.DM }),
          participants: [
            create(UserSchema, {
              id: 'u2',
              username: 'bob',
              displayName: 'Bob',
            }),
          ],
        }),
      ],
    });
    maybeShowDesktopNotification(base);
    expect(show).toHaveBeenCalledWith('Bob', 'sent you a message', {
      channelId: 'c1',
      kind: 'dm',
      userId: 'me',
    });
  });
});
