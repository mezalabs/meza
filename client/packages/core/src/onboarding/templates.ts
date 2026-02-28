import { ChannelType } from '@meza/gen/meza/v1/models_pb.ts';
import { Permissions } from '../store/permissions.ts';

export interface TemplateChannel {
  name: string;
  type: ChannelType;
  isDefault: boolean;
  isPrivate?: boolean;
  roleNames?: string[]; // roles (by name) that get access when private
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
  channels: TemplateChannel[];
  roles: TemplateRole[];
}

const MOD_PERMISSIONS =
  Permissions.KICK_MEMBERS |
  Permissions.BAN_MEMBERS |
  Permissions.MANAGE_MESSAGES |
  Permissions.TIMEOUT_MEMBERS;

const MOD_ROLE: TemplateRole = {
  name: 'Mod',
  permissions: MOD_PERMISSIONS,
  color: 0,
  isSelfAssignable: false,
};

export const SERVER_TEMPLATES: ServerTemplate[] = [
  {
    id: 'gaming',
    name: 'Gaming',
    description: 'For gaming communities with LFG and clips',
    icon: 'gamepad-2',
    channels: [
      { name: 'general', type: ChannelType.TEXT, isDefault: true },
      { name: 'looking-for-group', type: ChannelType.TEXT, isDefault: false },
      { name: 'clips', type: ChannelType.TEXT, isDefault: false },
      { name: 'off-topic', type: ChannelType.TEXT, isDefault: false },
    ],
    roles: [MOD_ROLE],
  },
  {
    id: 'friends',
    name: 'Friends',
    description: 'A chill space for you and your friends',
    icon: 'handshake',
    channels: [
      { name: 'general', type: ChannelType.TEXT, isDefault: true },
      { name: 'memes', type: ChannelType.TEXT, isDefault: false },
      { name: 'off-topic', type: ChannelType.TEXT, isDefault: false },
    ],
    roles: [],
  },
  {
    id: 'creator',
    name: 'Creator',
    description: 'For content creators and their audience',
    icon: 'palette',
    channels: [
      { name: 'general', type: ChannelType.TEXT, isDefault: true },
      { name: 'announcements', type: ChannelType.TEXT, isDefault: true },
      { name: 'feedback', type: ChannelType.TEXT, isDefault: false },
      { name: 'showcase', type: ChannelType.TEXT, isDefault: false },
      {
        name: 'mod-chat',
        type: ChannelType.TEXT,
        isDefault: false,
        isPrivate: true,
        roleNames: ['Mod'],
      },
    ],
    roles: [MOD_ROLE],
  },
  {
    id: 'community',
    name: 'Community',
    description: 'A general-purpose community server',
    icon: 'globe',
    channels: [
      { name: 'general', type: ChannelType.TEXT, isDefault: true },
      { name: 'announcements', type: ChannelType.TEXT, isDefault: true },
      { name: 'introductions', type: ChannelType.TEXT, isDefault: false },
      { name: 'off-topic', type: ChannelType.TEXT, isDefault: false },
      {
        name: 'mod-chat',
        type: ChannelType.TEXT,
        isDefault: false,
        isPrivate: true,
        roleNames: ['Mod'],
      },
    ],
    roles: [MOD_ROLE],
  },
  {
    id: 'scratch',
    name: 'Start from Scratch',
    description: 'A blank slate — set it up your way',
    icon: 'sparkles',
    channels: [{ name: 'general', type: ChannelType.TEXT, isDefault: true }],
    roles: [],
  },
];

// Voice channel additions per template (only applied if LiveKit is available).
export const VOICE_CHANNELS: Record<string, Array<{ name: string }>> = {
  gaming: [{ name: 'Voice Chat' }, { name: 'AFK' }],
  friends: [{ name: 'Hangout' }],
  creator: [{ name: 'Live' }, { name: 'Hangout' }],
  community: [{ name: 'Voice Chat' }],
};
