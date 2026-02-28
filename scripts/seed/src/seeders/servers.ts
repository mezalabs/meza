import { query } from '../lib/db.ts';
import {
  ALL_PERMS,
  DEFAULT_EVERYONE_PERMS,
  MOD_PERMS,
  S1_CH_GENERAL,
  S1_CH_PRIVATE,
  S1_CH_RANDOM,
  S1_CH_VOICE,
  S1_GROUP_TEXT,
  S1_GROUP_VOICE,
  S1_ROLE_ADMIN,
  S1_ROLE_MOD,
  S2_CH_ANNOUNCE,
  S2_CH_GENERAL,
  SERVER1_ID,
  SERVER2_ID,
} from '../lib/ids.ts';
import { log, logIndent } from '../lib/log.ts';
import type { SeededUser } from './users.ts';

/**
 * Seed servers, channel groups, channels, roles, members, and role assignments.
 * All inserts use ON CONFLICT DO NOTHING for idempotency.
 */
export async function seedServers(users: Record<string, SeededUser>): Promise<void> {
  const alice = users.alice;
  const bob = users.bob;
  const charlie = users.charlie;

  log('Creating servers...');

  // ── Server 1: Meza Dev (owner: alice) ──
  await query(
    `INSERT INTO servers (id, name, icon_url, owner_id, created_at, updated_at)
     VALUES ($1, 'Meza Dev', '', $2, now(), now())
     ON CONFLICT (id) DO NOTHING`,
    [SERVER1_ID, alice.id],
  );
  logIndent('"Meza Dev" (owner: alice) ... created');

  // Members
  await insertMember(alice.id, SERVER1_ID);
  await insertMember(bob.id, SERVER1_ID);
  await insertMember(charlie.id, SERVER1_ID);

  // Channel groups
  await query(
    `INSERT INTO channel_groups (id, server_id, name, position, created_at)
     VALUES ($1, $2, 'Text Channels', 0, now())
     ON CONFLICT (id) DO NOTHING`,
    [S1_GROUP_TEXT, SERVER1_ID],
  );
  await query(
    `INSERT INTO channel_groups (id, server_id, name, position, created_at)
     VALUES ($1, $2, 'Voice Channels', 1, now())
     ON CONFLICT (id) DO NOTHING`,
    [S1_GROUP_VOICE, SERVER1_ID],
  );

  // Channels
  await insertChannel(S1_CH_GENERAL, SERVER1_ID, 'general', 1, 0, false, true, S1_GROUP_TEXT);
  logIndent('  #general (text, default)');
  await insertChannel(S1_CH_RANDOM, SERVER1_ID, 'random', 1, 1, false, false, S1_GROUP_TEXT);
  logIndent('  #random (text)');
  await insertChannel(S1_CH_VOICE, SERVER1_ID, 'voice-chat', 2, 0, false, false, S1_GROUP_VOICE);
  logIndent('  #voice-chat (voice)');
  await insertChannel(S1_CH_PRIVATE, SERVER1_ID, 'private-stuff', 1, 2, true, false, S1_GROUP_TEXT);
  logIndent('  #private-stuff (private: alice, bob)');

  // Private channel members
  await insertChannelMember(S1_CH_PRIVATE, alice.id);
  await insertChannelMember(S1_CH_PRIVATE, bob.id);

  // Roles
  log('Creating roles...');

  // @everyone role (id = server_id)
  await query(
    `INSERT INTO roles (id, server_id, name, permissions, color, position, created_at)
     VALUES ($1, $1, '@everyone', $2, 0, 0, now())
     ON CONFLICT (id) DO NOTHING`,
    [SERVER1_ID, DEFAULT_EVERYONE_PERMS],
  );

  // Admin role
  await query(
    `INSERT INTO roles (id, server_id, name, permissions, color, position, created_at)
     VALUES ($1, $2, 'Admin', $3, 16744448, 1, now())
     ON CONFLICT (id) DO NOTHING`,
    [S1_ROLE_ADMIN, SERVER1_ID, ALL_PERMS],
  );

  // Moderator role
  await query(
    `INSERT INTO roles (id, server_id, name, permissions, color, position, created_at)
     VALUES ($1, $2, 'Moderator', $3, 3447003, 2, now())
     ON CONFLICT (id) DO NOTHING`,
    [S1_ROLE_MOD, SERVER1_ID, MOD_PERMS],
  );

  // Role assignments
  await insertMemberRole(alice.id, SERVER1_ID, S1_ROLE_ADMIN);
  await insertMemberRole(bob.id, SERVER1_ID, S1_ROLE_MOD);
  logIndent('Meza Dev: Admin (alice), Moderator (bob)');

  // ── Server 2: Test Server (owner: bob) ──
  await query(
    `INSERT INTO servers (id, name, icon_url, owner_id, created_at, updated_at)
     VALUES ($1, 'Test Server', '', $2, now(), now())
     ON CONFLICT (id) DO NOTHING`,
    [SERVER2_ID, bob.id],
  );
  logIndent('"Test Server" (owner: bob) ... created');

  // Members
  await insertMember(bob.id, SERVER2_ID);
  await insertMember(alice.id, SERVER2_ID);

  // @everyone role for server 2
  await query(
    `INSERT INTO roles (id, server_id, name, permissions, color, position, created_at)
     VALUES ($1, $1, '@everyone', $2, 0, 0, now())
     ON CONFLICT (id) DO NOTHING`,
    [SERVER2_ID, DEFAULT_EVERYONE_PERMS],
  );

  // Channels
  await insertChannel(S2_CH_GENERAL, SERVER2_ID, 'general', 1, 0, false, true, null);
  logIndent('  #general (text, default)');
  await insertChannel(S2_CH_ANNOUNCE, SERVER2_ID, 'announcements', 1, 1, false, false, null);
  logIndent('  #announcements (text)');
}

async function insertMember(userId: string, serverId: string): Promise<void> {
  await query(
    `INSERT INTO members (user_id, server_id, joined_at, updated_at, onboarding_completed_at, rules_acknowledged_at)
     VALUES ($1, $2, now(), now(), now(), now())
     ON CONFLICT DO NOTHING`,
    [userId, serverId],
  );
}

async function insertChannel(
  id: string,
  serverId: string,
  name: string,
  type: number,
  position: number,
  isPrivate: boolean,
  isDefault: boolean,
  channelGroupId: string | null,
): Promise<void> {
  await query(
    `INSERT INTO channels (id, server_id, name, type, position, is_private, is_default, channel_group_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), now())
     ON CONFLICT (id) DO NOTHING`,
    [id, serverId, name, type, position, isPrivate, isDefault, channelGroupId],
  );
}

async function insertChannelMember(channelId: string, userId: string): Promise<void> {
  await query(
    `INSERT INTO channel_members (channel_id, user_id, added_at)
     VALUES ($1, $2, now())
     ON CONFLICT DO NOTHING`,
    [channelId, userId],
  );
}

async function insertMemberRole(userId: string, serverId: string, roleId: string): Promise<void> {
  await query(
    `INSERT INTO member_roles (user_id, server_id, role_id)
     VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING`,
    [userId, serverId, roleId],
  );
}
