export const Permissions = {
  KICK_MEMBERS: 1n << 0n,
  BAN_MEMBERS: 1n << 1n,
  MANAGE_ROLES: 1n << 2n,
  ADMINISTRATOR: 1n << 3n,
  MANAGE_EMOJIS: 1n << 4n,
  MANAGE_CHANNELS: 1n << 5n,
  MANAGE_MESSAGES: 1n << 6n,
  TIMEOUT_MEMBERS: 1n << 7n,
  VIEW_AUDIT_LOG: 1n << 8n,
  EXEMPT_SLOW_MODE: 1n << 9n,
  STREAM_VIDEO: 1n << 10n,
  MANAGE_SOUNDBOARD: 1n << 11n,
  ADD_REACTIONS: 1n << 12n,
  VIEW_CHANNEL: 1n << 13n,
  SEND_MESSAGES: 1n << 14n,
  CONNECT: 1n << 15n,
  MENTION_EVERYONE: 1n << 16n,
  MANAGE_SERVER: 1n << 17n,
  CREATE_INVITE: 1n << 18n,
  EMBED_LINKS: 1n << 19n,
  ATTACH_FILES: 1n << 20n,
  READ_MESSAGE_HISTORY: 1n << 21n,
  USE_EXTERNAL_EMOJIS: 1n << 22n,
  SPEAK: 1n << 23n,
  MUTE_MEMBERS: 1n << 24n,
  DEAFEN_MEMBERS: 1n << 25n,
  MOVE_MEMBERS: 1n << 26n,
  CHANGE_NICKNAME: 1n << 27n,
  MANAGE_NICKNAMES: 1n << 28n,
  MANAGE_WEBHOOKS: 1n << 29n,
} as const;

/** OR of all 30 permission bits. */
export const ALL_PERMISSIONS = Object.values(Permissions).reduce(
  (acc, v) => acc | v,
  0n,
);

export const CHANNEL_SCOPED_PERMISSIONS =
  Permissions.MANAGE_MESSAGES |
  Permissions.EXEMPT_SLOW_MODE |
  Permissions.STREAM_VIDEO |
  Permissions.MANAGE_SOUNDBOARD |
  Permissions.ADD_REACTIONS |
  Permissions.VIEW_CHANNEL |
  Permissions.SEND_MESSAGES |
  Permissions.CONNECT |
  Permissions.MENTION_EVERYONE |
  Permissions.MANAGE_EMOJIS |
  Permissions.EMBED_LINKS |
  Permissions.ATTACH_FILES |
  Permissions.READ_MESSAGE_HISTORY |
  Permissions.USE_EXTERNAL_EMOJIS |
  Permissions.SPEAK |
  Permissions.MUTE_MEMBERS |
  Permissions.DEAFEN_MEMBERS |
  Permissions.MOVE_MEMBERS |
  Permissions.MANAGE_WEBHOOKS;

export function hasPermission(combined: bigint, perm: bigint): boolean {
  if ((combined & Permissions.ADMINISTRATOR) !== 0n) return true;
  return (combined & perm) !== 0n;
}

export function validateChannelScoped(perms: bigint): boolean {
  return (perms & ~CHANNEL_SCOPED_PERMISSIONS) === 0n;
}

export function validatePermissions(perms: bigint): boolean {
  return (perms & ~ALL_PERMISSIONS) === 0n;
}

export type PermCategory =
  | 'general'
  | 'text'
  | 'voice'
  | 'moderation'
  | 'server';

/** Derived union type for type-safe permission keys. */
export type PermissionKey = keyof typeof PERMISSION_INFO;

/** Channel type → which permission categories to show in override editor. */
export const CHANNEL_TYPE_CATEGORIES: Record<'text' | 'voice', PermCategory[]> =
  {
    text: ['general', 'text'],
    voice: ['general', 'voice'],
  };

/** Display metadata for each permission category. */
export const CATEGORY_META: Record<
  PermCategory,
  { label: string; icon: string }
> = {
  general: { label: 'General Permissions', icon: 'globe' },
  text: { label: 'Text Channel Permissions', icon: 'message-square' },
  voice: { label: 'Voice Channel Permissions', icon: 'volume-2' },
  moderation: { label: 'Moderation Permissions', icon: 'shield' },
  server: { label: 'Server Management', icon: 'settings' },
};

interface PermInfo {
  name: string;
  description: string;
  category: PermCategory;
}

export const PERMISSION_INFO = {
  KICK_MEMBERS: {
    name: 'Kick Members',
    description: 'Allows kicking members from the server',
    category: 'moderation',
  },
  BAN_MEMBERS: {
    name: 'Ban Members',
    description: 'Allows banning members from the server',
    category: 'moderation',
  },
  MANAGE_ROLES: {
    name: 'Manage Roles',
    description: 'Allows creating, editing, and deleting roles',
    category: 'server',
  },
  ADMINISTRATOR: {
    name: 'Administrator',
    description: 'Grants all permissions and bypasses channel overrides',
    category: 'server',
  },
  MANAGE_EMOJIS: {
    name: 'Manage Emojis',
    description: 'Allows managing custom emojis',
    category: 'server',
  },
  MANAGE_CHANNELS: {
    name: 'Manage Channels',
    description: 'Allows creating, editing, and deleting channels',
    category: 'server',
  },
  MANAGE_MESSAGES: {
    name: 'Manage Messages',
    description: "Allows deleting other members' messages and pinning messages",
    category: 'text',
  },
  TIMEOUT_MEMBERS: {
    name: 'Timeout Members',
    description: 'Allows temporarily restricting member permissions',
    category: 'moderation',
  },
  VIEW_AUDIT_LOG: {
    name: 'View Audit Log',
    description: 'Allows viewing the server audit log',
    category: 'server',
  },
  EXEMPT_SLOW_MODE: {
    name: 'Exempt from Slow Mode',
    description: 'Allows sending messages without slow mode restrictions',
    category: 'text',
  },
  STREAM_VIDEO: {
    name: 'Stream Video',
    description: 'Allows sharing screen in voice channels',
    category: 'voice',
  },
  MANAGE_SOUNDBOARD: {
    name: 'Manage Soundboard',
    description: 'Allows managing server soundboard sounds',
    category: 'voice',
  },
  ADD_REACTIONS: {
    name: 'Add Reactions',
    description: 'Allows adding emoji reactions to messages',
    category: 'text',
  },
  VIEW_CHANNEL: {
    name: 'View Channel',
    description: 'Allows viewing a channel',
    category: 'general',
  },
  SEND_MESSAGES: {
    name: 'Send Messages',
    description: 'Allows sending messages in text channels',
    category: 'text',
  },
  CONNECT: {
    name: 'Connect',
    description: 'Allows joining voice channels',
    category: 'voice',
  },
  MENTION_EVERYONE: {
    name: 'Mention Everyone',
    description: 'Allows using @everyone mentions',
    category: 'text',
  },
  MANAGE_SERVER: {
    name: 'Manage Server',
    description: 'Allows editing server name, icon, and settings',
    category: 'server',
  },
  CREATE_INVITE: {
    name: 'Create Invite',
    description: 'Allows creating invite links',
    category: 'general',
  },
  EMBED_LINKS: {
    name: 'Embed Links',
    description: 'Allows link previews to be displayed',
    category: 'text',
  },
  ATTACH_FILES: {
    name: 'Attach Files',
    description: 'Allows uploading files and images',
    category: 'text',
  },
  READ_MESSAGE_HISTORY: {
    name: 'Read Message History',
    description: 'Allows reading message history in channels',
    category: 'text',
  },
  USE_EXTERNAL_EMOJIS: {
    name: 'Use External Emojis',
    description: 'Allows using emojis from other servers',
    category: 'text',
  },
  SPEAK: {
    name: 'Speak',
    description: 'Allows speaking in voice channels',
    category: 'voice',
  },
  MUTE_MEMBERS: {
    name: 'Mute Members',
    description: 'Allows muting other members in voice channels',
    category: 'voice',
  },
  DEAFEN_MEMBERS: {
    name: 'Deafen Members',
    description: 'Allows deafening other members in voice channels',
    category: 'voice',
  },
  MOVE_MEMBERS: {
    name: 'Move Members',
    description: 'Allows moving members between voice channels',
    category: 'voice',
  },
  CHANGE_NICKNAME: {
    name: 'Change Nickname',
    description: 'Allows changing your own nickname',
    category: 'general',
  },
  MANAGE_NICKNAMES: {
    name: 'Manage Nicknames',
    description: "Allows changing other members' nicknames",
    category: 'moderation',
  },
  MANAGE_WEBHOOKS: {
    name: 'Manage Webhooks',
    description: 'Allows creating, editing, and deleting webhooks',
    category: 'server',
  },
} as const satisfies Record<string, PermInfo>;

/** Group permission keys by category for UI rendering. */
export const PERMISSIONS_BY_CATEGORY: Record<PermCategory, PermissionKey[]> = {
  general: ['VIEW_CHANNEL', 'CREATE_INVITE', 'CHANGE_NICKNAME'],
  text: [
    'SEND_MESSAGES',
    'EMBED_LINKS',
    'ATTACH_FILES',
    'ADD_REACTIONS',
    'MENTION_EVERYONE',
    'MANAGE_MESSAGES',
    'READ_MESSAGE_HISTORY',
    'USE_EXTERNAL_EMOJIS',
    'EXEMPT_SLOW_MODE',
  ],
  voice: [
    'CONNECT',
    'SPEAK',
    'STREAM_VIDEO',
    'MUTE_MEMBERS',
    'DEAFEN_MEMBERS',
    'MOVE_MEMBERS',
    'MANAGE_SOUNDBOARD',
  ],
  moderation: [
    'KICK_MEMBERS',
    'BAN_MEMBERS',
    'TIMEOUT_MEMBERS',
    'MANAGE_NICKNAMES',
  ],
  server: [
    'ADMINISTRATOR',
    'MANAGE_SERVER',
    'MANAGE_CHANNELS',
    'MANAGE_ROLES',
    'MANAGE_EMOJIS',
    'MANAGE_WEBHOOKS',
    'VIEW_AUDIT_LOG',
  ],
};
