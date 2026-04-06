import { ChannelType } from '@meza/gen/meza/v1/models_pb.ts';
import { Permissions } from '../store/permissions.ts';

export interface TemplateChannel {
  name: string;
  type: ChannelType;
  isDefault: boolean;
  isPrivate?: boolean;
  roleNames?: string[]; // roles (by name) that get access when private
  /** Matches a TemplateChannelGroup.name. Empty/unset means ungrouped. */
  groupName?: string;
}

export interface TemplateChannelGroup {
  name: string;
}

export interface TemplateRole {
  name: string;
  permissions: bigint;
  color: number;
  isSelfAssignable: boolean;
}

export interface ServerTemplate {
  id: string;
  name: string;
  description: string;
  icon: string;
  /** If undefined, server uses DefaultEveryonePermissions. */
  everyonePermissions?: bigint;
  /** Channel categories created before channels. Empty = no categories. */
  channelGroups: TemplateChannelGroup[];
  channels: TemplateChannel[];
  /** Voice channels appended to the template when voice is available. */
  voiceChannels?: TemplateChannel[];
  roles: TemplateRole[];
}

const MOD_PERMISSIONS =
  Permissions.KICK_MEMBERS |
  Permissions.BAN_MEMBERS |
  Permissions.MANAGE_MESSAGES |
  Permissions.TIMEOUT_MEMBERS |
  Permissions.VIEW_AUDIT_LOG;

const MOD_ROLE: TemplateRole = {
  name: 'Mod',
  permissions: MOD_PERMISSIONS,
  color: 0,
  isSelfAssignable: false,
};

// Friends servers grant everyone the "trusted friend" bit set: talking,
// streaming, reacting, inviting, attaching files, using external emojis, and
// pinging @everyone. Resource-management bits (webhooks, emojis, soundboard)
// stay off because they're impersonation/upload footguns even among friends,
// and all moderation/admin bits stay off so no one can nuke the place.
const FRIENDS_EVERYONE_PERMISSIONS =
  Permissions.VIEW_CHANNEL |
  Permissions.SEND_MESSAGES |
  Permissions.CONNECT |
  Permissions.SPEAK |
  Permissions.ADD_REACTIONS |
  Permissions.READ_MESSAGE_HISTORY |
  Permissions.EMBED_LINKS |
  Permissions.ATTACH_FILES |
  Permissions.USE_EXTERNAL_EMOJIS |
  Permissions.CREATE_INVITE |
  Permissions.CHANGE_NICKNAME |
  Permissions.STREAM_VIDEO |
  Permissions.EXEMPT_SLOW_MODE |
  Permissions.MENTION_EVERYONE;

export const SERVER_TEMPLATES: ServerTemplate[] = [
  {
    id: 'friends',
    name: 'Friends',
    description: 'A simple server for hanging out with friends',
    icon: 'handshake',
    everyonePermissions: FRIENDS_EVERYONE_PERMISSIONS,
    channelGroups: [],
    channels: [{ name: 'general', type: ChannelType.TEXT, isDefault: true }],
    voiceChannels: [
      { name: 'Hangout', type: ChannelType.VOICE, isDefault: false },
    ],
    roles: [],
  },
  {
    id: 'community',
    name: 'Community',
    description: 'An organized server for larger groups',
    icon: 'globe',
    channelGroups: [
      { name: 'Information' },
      { name: 'Chat' },
      { name: 'Moderation' },
      { name: 'Voice' },
    ],
    channels: [
      {
        name: 'announcements',
        type: ChannelType.TEXT,
        isDefault: true,
        groupName: 'Information',
      },
      {
        name: 'general',
        type: ChannelType.TEXT,
        isDefault: true,
        groupName: 'Chat',
      },
      {
        name: 'introductions',
        type: ChannelType.TEXT,
        isDefault: false,
        groupName: 'Chat',
      },
      {
        name: 'off-topic',
        type: ChannelType.TEXT,
        isDefault: false,
        groupName: 'Chat',
      },
      {
        name: 'mod-chat',
        type: ChannelType.TEXT,
        isDefault: false,
        isPrivate: true,
        roleNames: ['Mod'],
        groupName: 'Moderation',
      },
    ],
    voiceChannels: [
      {
        name: 'Voice Chat',
        type: ChannelType.VOICE,
        isDefault: false,
        groupName: 'Voice',
      },
    ],
    roles: [MOD_ROLE],
  },
];
