import { Code, ConnectError } from '@connectrpc/connect';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '../store/auth.ts';
import { useChannelStore } from '../store/channels.ts';
import { useEmojiStore } from '../store/emojis.ts';
import { useMemberStore } from '../store/members.ts';
import { useMessageStore } from '../store/messages.ts';
import { usePinStore } from '../store/pins.ts';
import { useReactionStore } from '../store/reactions.ts';
import { useRoleStore } from '../store/roles.ts';
import { useServerStore } from '../store/servers.ts';
import { useSoundStore } from '../store/sounds.ts';

// ---------------------------------------------------------------------------
// Mock the ConnectRPC client
// ---------------------------------------------------------------------------
const { mockClient } = vi.hoisted(() => {
  const fn = () => vi.fn();
  const mockClient: Record<string, ReturnType<typeof vi.fn>> = {
    listServers: fn(),
    createServer: fn(),
    listChannels: fn(),
    createChannel: fn(),
    getMessages: fn(),
    createInvite: fn(),
    resolveInvite: fn(),
    joinServer: fn(),
    listMembers: fn(),
    editMessage: fn(),
    deleteMessage: fn(),
    updateChannel: fn(),
    deleteChannel: fn(),
    sendMessage: fn(),
    kickMember: fn(),
    banMember: fn(),
    unbanMember: fn(),
    listBans: fn(),
    listRoles: fn(),
    createRole: fn(),
    updateRole: fn(),
    deleteRole: fn(),
    pinMessage: fn(),
    unpinMessage: fn(),
    getPinnedMessages: fn(),
    listEmojis: fn(),
    createEmoji: fn(),
    updateEmoji: fn(),
    deleteEmoji: fn(),
    updateMember: fn(),
    setMemberRoles: fn(),
    addChannelMember: fn(),
    removeChannelMember: fn(),
    listChannelMembers: fn(),
    listServerSounds: fn(),
    listUserSounds: fn(),
    createSound: fn(),
    updateSound: fn(),
    deleteSound: fn(),
    addReaction: fn(),
    removeReaction: fn(),
    getReactions: fn(),
  };
  return { mockClient };
});

vi.mock('@connectrpc/connect', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    createClient: vi.fn(() => mockClient),
  };
});

vi.mock('./client.ts', () => ({
  transport: {},
}));

vi.mock('./keys.ts', () => ({
  getPublicKeys: vi.fn(async () => ({})),
  storeKeyEnvelopes: vi.fn(async () => {}),
  listMembersWithViewChannel: vi.fn(async () => ({
    members: [],
    nextCursor: '',
  })),
}));

vi.mock('../crypto/index.ts', () => ({
  createChannelKey: vi.fn(() => ({
    key: new Uint8Array(32),
    version: 1,
  })),
  getIdentity: vi.fn(() => null),
  isSessionReady: vi.fn(() => false),
  provisionChannelKeyBatched: vi.fn(),
  wrapKeyForMembers: vi.fn(async () => []),
}));

beforeEach(() => {
  vi.clearAllMocks();
  useServerStore.setState({ servers: {}, isLoading: false, error: null });
  useChannelStore.setState({ byServer: {}, isLoading: false, error: null });
  useMessageStore.setState({
    byChannel: {},
    byId: {},
    hasMore: {},
    isLoading: {},
    error: {},
    viewMode: {},
    replyingTo: {},
  });
  useMemberStore.setState({ byServer: {}, isLoading: false, error: null });
  useRoleStore.setState({ byServer: {}, isLoading: false, error: null });
  useEmojiStore.setState({ byServer: {}, isLoading: false, error: null });
  usePinStore.setState({
    byChannel: {},
    hasMore: {},
    isLoading: {},
    error: {},
    pinnedIds: {},
  });
  useSoundStore.setState({
    byServer: {},
    personal: [],
    isLoading: false,
    error: null,
  });
  useReactionStore.setState({ byMessage: {} });
  useAuthStore.setState({
    accessToken: 'tok',
    refreshToken: 'ref',
    isAuthenticated: true,
    isLoading: false,
    error: null,
    user: {
      id: 'me',
      username: 'me',
      displayName: 'Me',
      avatarUrl: '',
      emojiScale: 1,
      bio: '',
      pronouns: '',
      bannerUrl: '',
      themeColorPrimary: '',
      themeColorSecondary: '',
      simpleMode: false,
      dmPrivacy: 'message_requests',
      connections: [],
      createdAt: '',
    },
  });
});

// ---------------------------------------------------------------------------
// listServers
// ---------------------------------------------------------------------------
describe('listServers', () => {
  it('stores servers on success', async () => {
    const { listServers } = await import('./chat.ts');
    const servers = [{ id: 's1', name: 'Test' }];
    mockClient.listServers.mockResolvedValue({ servers });

    await listServers();

    expect(useServerStore.getState().servers.s1).toBeDefined();
  });

  it('sets store error on failure', async () => {
    const { listServers } = await import('./chat.ts');
    mockClient.listServers.mockRejectedValue(
      new ConnectError('denied', Code.PermissionDenied),
    );

    await expect(listServers()).rejects.toThrow();
    expect(useServerStore.getState().error).toBe('You do not have access');
  });
});

// ---------------------------------------------------------------------------
// createServer
// ---------------------------------------------------------------------------
describe('createServer', () => {
  it('adds server to store on success', async () => {
    const { createServer } = await import('./chat.ts');
    mockClient.createServer.mockResolvedValue({
      server: { id: 's1', name: 'New' },
    });

    const result = await createServer('New');

    expect(result).toEqual({ id: 's1', name: 'New' });
    expect(useServerStore.getState().servers.s1).toBeDefined();
  });

  it('maps AlreadyExists to friendly message', async () => {
    const { createServer } = await import('./chat.ts');
    mockClient.createServer.mockRejectedValue(
      new ConnectError('dup', Code.AlreadyExists),
    );

    await expect(createServer('X')).rejects.toThrow();
    expect(useServerStore.getState().error).toBe(
      'You are already a member of this server',
    );
  });
});

// ---------------------------------------------------------------------------
// listChannels
// ---------------------------------------------------------------------------
describe('listChannels', () => {
  it('stores channels per server', async () => {
    const { listChannels } = await import('./chat.ts');
    const channels = [
      { id: 'ch1', serverId: 's1', name: 'general', position: 0 },
    ];
    mockClient.listChannels.mockResolvedValue({ channels });

    await listChannels('s1');

    expect(useChannelStore.getState().byServer.s1).toHaveLength(1);
  });

  it('sets channel store error on failure', async () => {
    const { listChannels } = await import('./chat.ts');
    mockClient.listChannels.mockRejectedValue(
      new ConnectError('nope', Code.NotFound),
    );

    await expect(listChannels('s1')).rejects.toThrow();
    expect(useChannelStore.getState().error).toBe('Not found');
  });
});

// ---------------------------------------------------------------------------
// getMessages
// ---------------------------------------------------------------------------
describe('getMessages', () => {
  it('stores messages for channel', async () => {
    const { getMessages } = await import('./chat.ts');
    const messages = [{ id: 'm1', channelId: 'c1' }];
    mockClient.getMessages.mockResolvedValue({ messages, hasMore: false });

    await getMessages('c1');

    expect(useMessageStore.getState().byChannel.c1).toHaveLength(1);
  });

  it('prepends messages when "before" option is used', async () => {
    const { getMessages } = await import('./chat.ts');
    useMessageStore
      .getState()
      .setMessages('c1', [{ id: 'm2', channelId: 'c1' } as never]);
    mockClient.getMessages.mockResolvedValue({
      messages: [{ id: 'm1', channelId: 'c1' }],
      hasMore: true,
    });

    await getMessages('c1', { before: 'm2' });

    expect(useMessageStore.getState().byChannel.c1).toHaveLength(2);
    expect(useMessageStore.getState().hasMore.c1).toBe(true);
  });

  it('replaces messages when "around" option is used', async () => {
    const { getMessages } = await import('./chat.ts');
    useMessageStore
      .getState()
      .setMessages('c1', [
        { id: 'm1', channelId: 'c1' } as never,
        { id: 'm2', channelId: 'c1' } as never,
      ]);
    mockClient.getMessages.mockResolvedValue({
      messages: [{ id: 'm3', channelId: 'c1' }],
      hasMore: false,
    });

    await getMessages('c1', { around: 'm3' });

    expect(useMessageStore.getState().byChannel.c1).toHaveLength(1);
    expect(useMessageStore.getState().byChannel.c1?.[0].id).toBe('m3');
  });

  it('sets per-channel error on failure', async () => {
    const { getMessages } = await import('./chat.ts');
    mockClient.getMessages.mockRejectedValue(
      new ConnectError('denied', Code.PermissionDenied),
    );

    await expect(getMessages('c1')).rejects.toThrow();
    expect(useMessageStore.getState().error.c1).toBe('You do not have access');
  });
});

// ---------------------------------------------------------------------------
// sendMessage
// ---------------------------------------------------------------------------
describe('sendMessage', () => {
  it('adds sent message to store immediately', async () => {
    const { sendMessage } = await import('./chat.ts');
    mockClient.sendMessage.mockResolvedValue({
      messageId: 'm1',
      createdAt: {},
    });

    await sendMessage({
      channelId: 'c1',
      encryptedContent: new Uint8Array(),
      nonce: 'n1',
    });

    expect(useMessageStore.getState().byChannel.c1).toHaveLength(1);
  });

  it('sets per-channel error on failure', async () => {
    const { sendMessage } = await import('./chat.ts');
    mockClient.sendMessage.mockRejectedValue(
      new ConnectError('too big', Code.ResourceExhausted),
    );

    await expect(
      sendMessage({
        channelId: 'c1',
        encryptedContent: new Uint8Array(),
        nonce: 'n1',
      }),
    ).rejects.toThrow();
    expect(useMessageStore.getState().error.c1).toBe(
      'Limit reached. Please try again later.',
    );
  });
});

// ---------------------------------------------------------------------------
// createChannel / updateChannel / deleteChannel
// ---------------------------------------------------------------------------
describe('channel CRUD', () => {
  it('createChannel adds to store', async () => {
    const { createChannel } = await import('./chat.ts');
    mockClient.createChannel.mockResolvedValue({
      channel: { id: 'ch1', serverId: 's1', name: 'new', position: 0 },
    });

    await createChannel('s1', 'new');
    expect(useChannelStore.getState().byServer.s1).toHaveLength(1);
  });

  it('updateChannel updates in store', async () => {
    const { updateChannel } = await import('./chat.ts');
    useChannelStore.getState().addChannel({
      id: 'ch1',
      serverId: 's1',
      name: 'old',
      position: 0,
    } as never);
    mockClient.updateChannel.mockResolvedValue({
      channel: { id: 'ch1', serverId: 's1', name: 'renamed', position: 0 },
    });

    await updateChannel('ch1', { name: 'renamed' });
    expect(useChannelStore.getState().byServer.s1?.[0].name).toBe('renamed');
  });

  it('deleteChannel removes from store', async () => {
    const { deleteChannel } = await import('./chat.ts');
    useChannelStore.getState().addChannel({
      id: 'ch1',
      serverId: 's1',
      name: 'gen',
      position: 0,
    } as never);
    mockClient.deleteChannel.mockResolvedValue({});

    await deleteChannel('ch1');
    expect(useChannelStore.getState().byServer.s1).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Invite / join
// ---------------------------------------------------------------------------
describe('invites', () => {
  it('createInvite returns invite', async () => {
    const { createInvite } = await import('./chat.ts');
    mockClient.createInvite.mockResolvedValue({ invite: { code: 'abc123' } });

    const invite = await createInvite('s1');
    expect(invite).toEqual({ code: 'abc123' });
  });

  it('createInvite wraps error', async () => {
    const { createInvite } = await import('./chat.ts');
    mockClient.createInvite.mockRejectedValue(
      new ConnectError('nope', Code.PermissionDenied),
    );

    await expect(createInvite('s1')).rejects.toThrow('You do not have access');
  });

  it('joinServer adds server to store', async () => {
    const { joinServer } = await import('./chat.ts');
    mockClient.joinServer.mockResolvedValue({
      server: { id: 's1', name: 'Joined' },
    });

    await joinServer('abc');
    expect(useServerStore.getState().servers.s1).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// listMembers
// ---------------------------------------------------------------------------
describe('listMembers', () => {
  it('stores members for server', async () => {
    const { listMembers } = await import('./chat.ts');
    mockClient.listMembers.mockResolvedValue({
      members: [{ userId: 'u1', serverId: 's1' }],
      users: [],
    });

    await listMembers('s1');
    expect(useMemberStore.getState().byServer.s1).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Moderation: kick / ban / unban / listBans
// ---------------------------------------------------------------------------
describe('moderation', () => {
  it('kickMember calls client', async () => {
    const { kickMember } = await import('./chat.ts');
    mockClient.kickMember.mockResolvedValue({});

    await kickMember('s1', 'u1');
    expect(mockClient.kickMember).toHaveBeenCalledWith({
      serverId: 's1',
      userId: 'u1',
    });
  });

  it('kickMember wraps error', async () => {
    const { kickMember } = await import('./chat.ts');
    mockClient.kickMember.mockRejectedValue(
      new ConnectError('denied', Code.PermissionDenied),
    );

    await expect(kickMember('s1', 'u1')).rejects.toThrow(
      'You do not have access',
    );
  });

  it('banMember calls client with reason', async () => {
    const { banMember } = await import('./chat.ts');
    mockClient.banMember.mockResolvedValue({});

    await banMember('s1', 'u1', 'spamming');
    expect(mockClient.banMember).toHaveBeenCalledWith({
      serverId: 's1',
      userId: 'u1',
      reason: 'spamming',
    });
  });

  it('unbanMember calls client', async () => {
    const { unbanMember } = await import('./chat.ts');
    mockClient.unbanMember.mockResolvedValue({});

    await unbanMember('s1', 'u1');
    expect(mockClient.unbanMember).toHaveBeenCalledWith({
      serverId: 's1',
      userId: 'u1',
    });
  });

  it('listBans returns bans', async () => {
    const { listBans } = await import('./chat.ts');
    mockClient.listBans.mockResolvedValue({ bans: [{ userId: 'u1' }] });

    const bans = await listBans('s1');
    expect(bans).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Role API
// ---------------------------------------------------------------------------
describe('role API', () => {
  it('listRoles stores roles', async () => {
    const { listRoles } = await import('./chat.ts');
    mockClient.listRoles.mockResolvedValue({
      roles: [
        {
          id: 'r1',
          serverId: 's1',
          name: 'Admin',
          position: 10,
          permissions: 0n,
          color: 0,
        },
      ],
    });

    await listRoles('s1');
    expect(useRoleStore.getState().byServer.s1).toHaveLength(1);
  });

  it('createRole adds to store', async () => {
    const { createRole } = await import('./chat.ts');
    mockClient.createRole.mockResolvedValue({
      role: {
        id: 'r1',
        serverId: 's1',
        name: 'Mod',
        position: 5,
        permissions: 0n,
        color: 0,
      },
    });

    await createRole('s1', 'Mod');
    expect(useRoleStore.getState().byServer.s1).toHaveLength(1);
  });

  it('updateRole updates in store', async () => {
    const { updateRole } = await import('./chat.ts');
    useRoleStore.getState().setRoles('s1', [
      {
        id: 'r1',
        serverId: 's1',
        name: 'Mod',
        position: 5,
        permissions: 0n,
        color: 0,
      } as never,
    ]);
    mockClient.updateRole.mockResolvedValue({
      role: {
        id: 'r1',
        serverId: 's1',
        name: 'Super Mod',
        position: 10,
        permissions: 0n,
        color: 0,
      },
    });

    await updateRole('r1', { name: 'Super Mod' });
    expect(useRoleStore.getState().byServer.s1?.[0].name).toBe('Super Mod');
  });

  it('deleteRole calls client', async () => {
    const { deleteRole } = await import('./chat.ts');
    mockClient.deleteRole.mockResolvedValue({});

    await deleteRole('r1');
    expect(mockClient.deleteRole).toHaveBeenCalledWith({ roleId: 'r1' });
  });

  it('deleteRole wraps error', async () => {
    const { deleteRole } = await import('./chat.ts');
    mockClient.deleteRole.mockRejectedValue(
      new ConnectError('denied', Code.PermissionDenied),
    );

    await expect(deleteRole('r1')).rejects.toThrow('You do not have access');
  });
});

// ---------------------------------------------------------------------------
// Pin API
// ---------------------------------------------------------------------------
describe('pin API', () => {
  it('pinMessage adds to store', async () => {
    const { pinMessage } = await import('./chat.ts');
    mockClient.pinMessage.mockResolvedValue({
      pinnedMessage: { message: { id: 'm1', channelId: 'c1' }, pinnedAt: {} },
    });

    await pinMessage('c1', 'm1');
    expect(usePinStore.getState().byChannel.c1).toHaveLength(1);
  });

  it('unpinMessage removes from store', async () => {
    const { unpinMessage } = await import('./chat.ts');
    usePinStore
      .getState()
      .setPinnedMessages(
        'c1',
        [{ message: { id: 'm1', channelId: 'c1' }, pinnedAt: {} } as never],
        false,
      );
    mockClient.unpinMessage.mockResolvedValue({});

    await unpinMessage('c1', 'm1');
    expect(usePinStore.getState().byChannel.c1).toHaveLength(0);
  });

  it('getPinnedMessages stores pins', async () => {
    const { getPinnedMessages } = await import('./chat.ts');
    mockClient.getPinnedMessages.mockResolvedValue({
      pinnedMessages: [
        { message: { id: 'm1', channelId: 'c1' }, pinnedAt: {} },
      ],
      hasMore: true,
    });

    await getPinnedMessages('c1');
    expect(usePinStore.getState().byChannel.c1).toHaveLength(1);
    expect(usePinStore.getState().hasMore.c1).toBe(true);
  });

  it('getPinnedMessages appends when "before" is provided', async () => {
    const { getPinnedMessages } = await import('./chat.ts');
    usePinStore
      .getState()
      .setPinnedMessages(
        'c1',
        [{ message: { id: 'm1', channelId: 'c1' }, pinnedAt: {} } as never],
        true,
      );
    mockClient.getPinnedMessages.mockResolvedValue({
      pinnedMessages: [
        { message: { id: 'm2', channelId: 'c1' }, pinnedAt: {} },
      ],
      hasMore: false,
    });

    await getPinnedMessages('c1', 'cursor');
    expect(usePinStore.getState().byChannel.c1).toHaveLength(2);
    expect(usePinStore.getState().hasMore.c1).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Emoji API
// ---------------------------------------------------------------------------
describe('emoji API', () => {
  it('listEmojis stores emojis', async () => {
    const { listEmojis } = await import('./chat.ts');
    mockClient.listEmojis.mockResolvedValue({
      emojis: [
        { id: 'e1', serverId: 's1', name: 'fire', imageUrl: '/media/1' },
      ],
    });

    await listEmojis('s1');
    expect(useEmojiStore.getState().byServer.s1).toHaveLength(1);
  });

  it('createEmoji adds to store', async () => {
    const { createEmoji } = await import('./chat.ts');
    mockClient.createEmoji.mockResolvedValue({
      emoji: { id: 'e1', serverId: 's1', name: 'fire', imageUrl: '/media/1' },
    });

    await createEmoji('s1', 'fire', 'att1');
    expect(useEmojiStore.getState().byServer.s1).toHaveLength(1);
  });

  it('updateEmoji updates in store', async () => {
    const { updateEmoji } = await import('./chat.ts');
    useEmojiStore.getState().setEmojis('s1', [
      {
        id: 'e1',
        serverId: 's1',
        name: 'fire',
        imageUrl: '/media/1',
      } as never,
    ]);
    mockClient.updateEmoji.mockResolvedValue({
      emoji: { id: 'e1', serverId: 's1', name: 'blaze', imageUrl: '/media/1' },
    });

    await updateEmoji('e1', 'blaze');
    expect(useEmojiStore.getState().byServer.s1?.[0].name).toBe('blaze');
  });

  it('deleteEmoji wraps error', async () => {
    const { deleteEmoji } = await import('./chat.ts');
    mockClient.deleteEmoji.mockRejectedValue(
      new ConnectError('denied', Code.PermissionDenied),
    );

    await expect(deleteEmoji('e1')).rejects.toThrow('You do not have access');
  });
});

// ---------------------------------------------------------------------------
// Sound API
// ---------------------------------------------------------------------------
describe('sound API', () => {
  it('listServerSounds stores sounds', async () => {
    const { listServerSounds } = await import('./chat.ts');
    mockClient.listServerSounds.mockResolvedValue({
      sounds: [{ id: 'snd1', serverId: 's1', name: 'airhorn' }],
    });

    await listServerSounds('s1');
    expect(useSoundStore.getState().byServer.s1).toHaveLength(1);
  });

  it('listUserSounds stores personal sounds', async () => {
    const { listUserSounds } = await import('./chat.ts');
    mockClient.listUserSounds.mockResolvedValue({
      sounds: [{ id: 'snd1', serverId: '', name: 'beep' }],
    });

    await listUserSounds();
    expect(useSoundStore.getState().personal).toHaveLength(1);
  });

  it('createSound adds to store', async () => {
    const { createSound } = await import('./chat.ts');
    mockClient.createSound.mockResolvedValue({
      sound: { id: 'snd1', serverId: 's1', name: 'horn' },
    });

    await createSound('horn', 'att1', 's1');
    expect(useSoundStore.getState().byServer.s1).toHaveLength(1);
  });

  it('updateSound updates in store', async () => {
    const { updateSound } = await import('./chat.ts');
    useSoundStore.getState().setServerSounds('s1', [
      {
        id: 'snd1',
        serverId: 's1',
        name: 'airhorn',
        audioUrl: '/m/1',
      } as never,
    ]);
    mockClient.updateSound.mockResolvedValue({
      sound: { id: 'snd1', serverId: 's1', name: 'horn' },
    });

    await updateSound('snd1', 'horn');
    expect(useSoundStore.getState().byServer.s1?.[0].name).toBe('horn');
  });

  it('deleteSound wraps error', async () => {
    const { deleteSound } = await import('./chat.ts');
    mockClient.deleteSound.mockRejectedValue(
      new ConnectError('not found', Code.NotFound),
    );

    await expect(deleteSound('snd1')).rejects.toThrow('Not found');
  });
});

// ---------------------------------------------------------------------------
// Channel member API
// ---------------------------------------------------------------------------
describe('channel member API', () => {
  it('addChannelMember calls client', async () => {
    const { addChannelMember } = await import('./chat.ts');
    mockClient.addChannelMember.mockResolvedValue({});

    await addChannelMember('ch1', 'u1');
    expect(mockClient.addChannelMember).toHaveBeenCalledWith({
      channelId: 'ch1',
      userId: 'u1',
    });
  });

  it('removeChannelMember calls client', async () => {
    const { removeChannelMember } = await import('./chat.ts');
    mockClient.removeChannelMember.mockResolvedValue({});

    await removeChannelMember('ch1', 'u1');
    expect(mockClient.removeChannelMember).toHaveBeenCalledWith({
      channelId: 'ch1',
      userId: 'u1',
    });
  });

  it('listChannelMembers returns members', async () => {
    const { listChannelMembers } = await import('./chat.ts');
    mockClient.listChannelMembers.mockResolvedValue({
      members: [{ userId: 'u1' }, { userId: 'u2' }],
    });

    const members = await listChannelMembers('ch1');
    expect(members).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// editMessage
// ---------------------------------------------------------------------------
describe('editMessage', () => {
  it('calls client with correct args and returns editedAt', async () => {
    const { editMessage } = await import('./chat.ts');
    const editedAt = { seconds: BigInt(1700000000), nanos: 0 };
    mockClient.editMessage.mockResolvedValue({ editedAt });

    const params = {
      channelId: 'c1',
      messageId: 'm1',
      encryptedContent: new Uint8Array([1, 2, 3]),
    };
    const result = await editMessage(params);

    expect(mockClient.editMessage).toHaveBeenCalledWith({
      ...params,
      keyVersion: 0,
    });
    expect(result).toEqual({ editedAt });
  });

  it('wraps error on failure', async () => {
    const { editMessage } = await import('./chat.ts');
    mockClient.editMessage.mockRejectedValue(
      new ConnectError('denied', Code.PermissionDenied),
    );

    await expect(
      editMessage({
        channelId: 'c1',
        messageId: 'm1',
        encryptedContent: new Uint8Array(),
      }),
    ).rejects.toThrow('You do not have access');
  });
});

// ---------------------------------------------------------------------------
// deleteMessage
// ---------------------------------------------------------------------------
describe('deleteMessage', () => {
  it('calls client with correct args', async () => {
    const { deleteMessage } = await import('./chat.ts');
    mockClient.deleteMessage.mockResolvedValue({});

    await deleteMessage('c1', 'm1');

    expect(mockClient.deleteMessage).toHaveBeenCalledWith({
      channelId: 'c1',
      messageId: 'm1',
    });
  });

  it('wraps error on failure', async () => {
    const { deleteMessage } = await import('./chat.ts');
    mockClient.deleteMessage.mockRejectedValue(
      new ConnectError('not found', Code.NotFound),
    );

    await expect(deleteMessage('c1', 'm1')).rejects.toThrow('Not found');
  });
});

// ---------------------------------------------------------------------------
// addReaction
// ---------------------------------------------------------------------------
describe('addReaction', () => {
  it('calls client with correct args', async () => {
    const { addReaction } = await import('./chat.ts');
    mockClient.addReaction.mockResolvedValue({});

    await addReaction('c1', 'm1', '👍');

    expect(mockClient.addReaction).toHaveBeenCalledWith({
      channelId: 'c1',
      messageId: 'm1',
      emoji: '👍',
    });
  });

  it('wraps error on failure', async () => {
    const { addReaction } = await import('./chat.ts');
    mockClient.addReaction.mockRejectedValue(
      new ConnectError('denied', Code.PermissionDenied),
    );

    await expect(addReaction('c1', 'm1', '👍')).rejects.toThrow(
      'You do not have access',
    );
  });
});

// ---------------------------------------------------------------------------
// removeReaction
// ---------------------------------------------------------------------------
describe('removeReaction', () => {
  it('calls client with correct args', async () => {
    const { removeReaction } = await import('./chat.ts');
    mockClient.removeReaction.mockResolvedValue({});

    await removeReaction('c1', 'm1', '👍');

    expect(mockClient.removeReaction).toHaveBeenCalledWith({
      channelId: 'c1',
      messageId: 'm1',
      emoji: '👍',
    });
  });

  it('wraps error on failure', async () => {
    const { removeReaction } = await import('./chat.ts');
    mockClient.removeReaction.mockRejectedValue(
      new ConnectError('not found', Code.NotFound),
    );

    await expect(removeReaction('c1', 'm1', '👍')).rejects.toThrow('Not found');
  });
});

// ---------------------------------------------------------------------------
// getReactions
// ---------------------------------------------------------------------------
describe('getReactions', () => {
  it('returns reactions and updates the reaction store', async () => {
    const { getReactions } = await import('./chat.ts');
    const reactions = {
      m1: { groups: [{ emoji: '👍', me: true, userIds: ['u1'] }] },
      m2: { groups: [{ emoji: '🔥', me: false, userIds: ['u2'] }] },
    };
    mockClient.getReactions.mockResolvedValue({ reactions });

    const result = await getReactions('c1', ['m1', 'm2']);

    expect(mockClient.getReactions).toHaveBeenCalledWith({
      channelId: 'c1',
      messageIds: ['m1', 'm2'],
    });
    expect(result).toEqual(reactions);
    expect(useReactionStore.getState().byMessage.m1).toEqual(
      reactions.m1.groups,
    );
    expect(useReactionStore.getState().byMessage.m2).toEqual(
      reactions.m2.groups,
    );
  });

  it('wraps error on failure', async () => {
    const { getReactions } = await import('./chat.ts');
    mockClient.getReactions.mockRejectedValue(
      new ConnectError('denied', Code.PermissionDenied),
    );

    await expect(getReactions('c1', ['m1'])).rejects.toThrow(
      'You do not have access',
    );
  });
});

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------
describe('error mapping', () => {
  it('maps Unauthenticated to session expired', async () => {
    const { listServers } = await import('./chat.ts');
    mockClient.listServers.mockRejectedValue(
      new ConnectError('expired', Code.Unauthenticated),
    );

    await expect(listServers()).rejects.toThrow();
    expect(useServerStore.getState().error).toBe(
      'Your session has expired. Please log in again.',
    );
  });

  it('maps InvalidArgument to fixed user-facing message', async () => {
    const { listServers } = await import('./chat.ts');
    mockClient.listServers.mockRejectedValue(
      new ConnectError('Name too long', Code.InvalidArgument),
    );

    await expect(listServers()).rejects.toThrow();
    expect(useServerStore.getState().error).toBe(
      'Invalid input. Please check your request.',
    );
  });

  it('maps unknown ConnectError to generic message', async () => {
    const { listServers } = await import('./chat.ts');
    mockClient.listServers.mockRejectedValue(
      new ConnectError('weird', Code.Internal),
    );

    await expect(listServers()).rejects.toThrow();
    expect(useServerStore.getState().error).toBe(
      'Something went wrong. Please try again.',
    );
  });

  it('maps non-ConnectError to network error', async () => {
    const { listServers } = await import('./chat.ts');
    mockClient.listServers.mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(listServers()).rejects.toThrow();
    expect(useServerStore.getState().error).toBe(
      'Network error. Please check your connection.',
    );
  });
});
