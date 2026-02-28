export const SEED_USERS = {
  alice: {
    email: 'alice@seed.meza.local',
    username: 'alice',
    password: 'password123',
  },
  bob: {
    email: 'bob@seed.meza.local',
    username: 'bob',
    password: 'password123',
  },
  charlie: {
    email: 'charlie@seed.meza.local',
    username: 'charlie',
    password: 'password123',
  },
} as const;

export const SEED_EMAIL_DOMAIN = '@seed.meza.local';

// Servers
export const SERVER1_ID = '01SEED000SRV1000000000000'; // "Meza Dev" (owner: alice)
export const SERVER2_ID = '01SEED000SRV2000000000000'; // "Test Server" (owner: bob)

// Channel groups (server 1)
export const S1_GROUP_TEXT = '01SEED000CGRPTXT100000000';
export const S1_GROUP_VOICE = '01SEED000CGRPVCE100000000';

// Channels (server 1)
export const S1_CH_GENERAL = '01SEED000CH1GENERAL0000000'; // text, default
export const S1_CH_RANDOM = '01SEED000CH1RANDOM00000000'; // text
export const S1_CH_VOICE = '01SEED000CH1VOICE000000000'; // voice
export const S1_CH_PRIVATE = '01SEED000CH1PRIVATE0000000'; // private text

// Channels (server 2)
export const S2_CH_GENERAL = '01SEED000CH2GENERAL0000000'; // text, default
export const S2_CH_ANNOUNCE = '01SEED000CH2ANNOUNCE000000'; // text

// Roles (server 1) — @everyone role id = server_id
export const S1_ROLE_ADMIN = '01SEED000ROLE1ADMIN0000000';
export const S1_ROLE_MOD = '01SEED000ROLE1MOD000000000';

// Permission constants (from server/internal/permissions/permissions.go)
export const DEFAULT_EVERYONE_PERMS = 150794240;
export const ALL_PERMS = 2147483647;
// Moderator perms: default + ManageMessages(6) + KickMembers(0) + BanMembers(1) +
// TimeoutMembers(7) + MuteMembers(24) + DeafenMembers(25)
export const MOD_PERMS =
  DEFAULT_EVERYONE_PERMS | (1 << 0) | (1 << 1) | (1 << 6) | (1 << 7) | (1 << 24) | (1 << 25);
