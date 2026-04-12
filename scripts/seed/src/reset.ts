import { query } from './lib/db.ts';
import { connectScylla, disconnectScylla, scyllaQuery } from './lib/scylla.ts';
import type { SeedConfig } from './lib/config.ts';
import { SEED_EMAIL_DOMAIN } from './lib/ids.ts';
import { log, logIndent, logWarn } from './lib/log.ts';

/**
 * Delete all seed data in dependency order.
 * Anchored to the @seed.meza.local email domain.
 * Cleans both PostgreSQL and ScyllaDB.
 */
export async function resetSeedData(config: SeedConfig): Promise<void> {
  log('Resetting seed data...');

  const seedUserIds = `SELECT id FROM users WHERE email LIKE '%${SEED_EMAIL_DOMAIN}'`;
  const seedServerIds = `SELECT id FROM servers WHERE owner_id IN (${seedUserIds})`;
  const seedChannelIds = `SELECT id FROM channels WHERE server_id IN (${seedServerIds})`;
  // DM channels owned by seed users (type=3 with dm_pair_key involving seed user IDs)
  const seedDMChannelIds = `SELECT channel_id FROM channel_members WHERE user_id IN (${seedUserIds}) AND channel_id IN (SELECT id FROM channels WHERE type = 3)`;

  const steps = [
    // Messages and reactions
    ['message_reactions', `DELETE FROM message_reactions WHERE channel_id IN (${seedChannelIds}) OR channel_id IN (${seedDMChannelIds})`],
    // Channel key envelopes
    ['channel_key_envelopes', `DELETE FROM channel_key_envelopes WHERE channel_id IN (${seedChannelIds}) OR channel_id IN (${seedDMChannelIds})`],
    ['channel_key_versions', `DELETE FROM channel_key_versions WHERE channel_id IN (${seedChannelIds}) OR channel_id IN (${seedDMChannelIds})`],
    // Read states
    ['channel_read_states', `DELETE FROM channel_read_states WHERE user_id IN (${seedUserIds})`],
    // Webhooks
    ['webhook_deliveries', `DELETE FROM webhook_deliveries WHERE webhook_id IN (SELECT id FROM webhooks WHERE channel_id IN (${seedChannelIds}))`],
    ['webhooks', `DELETE FROM webhooks WHERE channel_id IN (${seedChannelIds})`],
    // Server structure
    ['member_roles', `DELETE FROM member_roles WHERE user_id IN (${seedUserIds})`],
    ['channel_members', `DELETE FROM channel_members WHERE user_id IN (${seedUserIds})`],
    ['pinned_messages', `DELETE FROM pinned_messages WHERE channel_id IN (${seedChannelIds})`],
    ['roles', `DELETE FROM roles WHERE server_id IN (${seedServerIds})`],
    ['invites', `DELETE FROM invites WHERE server_id IN (${seedServerIds})`],
    // DM channels (type=3 involving seed users)
    ['dm_channels', `DELETE FROM channels WHERE type = 3 AND id IN (${seedDMChannelIds})`],
    // Server channels
    ['channels', `DELETE FROM channels WHERE server_id IN (${seedServerIds})`],
    ['channel_groups', `DELETE FROM channel_groups WHERE server_id IN (${seedServerIds})`],
    ['members', `DELETE FROM members WHERE server_id IN (${seedServerIds})`],
    ['servers', `DELETE FROM servers WHERE owner_id IN (${seedUserIds})`],
    ['friendships', `DELETE FROM friendships WHERE requester_id IN (${seedUserIds}) OR addressee_id IN (${seedUserIds})`],
    ['devices', `DELETE FROM devices WHERE user_id IN (${seedUserIds})`],
    ['mls_key_packages', `DELETE FROM mls_key_packages WHERE user_id IN (${seedUserIds})`],
    ['user_auth', `DELETE FROM user_auth WHERE user_id IN (${seedUserIds})`],
    ['users', `DELETE FROM users WHERE email LIKE '%${SEED_EMAIL_DOMAIN}'`],
  ] as const;

  for (const [table, sql] of steps) {
    try {
      const res = await query(sql);
      if (res.rowCount && res.rowCount > 0) {
        logIndent(`${table}: ${res.rowCount} rows deleted`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('does not exist')) continue;
      throw err;
    }
  }

  // Clean ScyllaDB messages for seeded channels
  await resetScyllaMessages(config);

  log('Seed data reset complete.');
}

async function resetScyllaMessages(config: SeedConfig): Promise<void> {
  // Get all seeded channel IDs (server channels + DMs)
  const serverChannels = await query(
    `SELECT id FROM channels WHERE server_id IN
     (SELECT id FROM servers WHERE owner_id IN
       (SELECT id FROM users WHERE email LIKE $1))`,
    [`%${SEED_EMAIL_DOMAIN}`],
  );
  const dmChannels = await query(
    `SELECT DISTINCT channel_id AS id FROM channel_members
     WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)
       AND channel_id IN (SELECT id FROM channels WHERE type = 3)`,
    [`%${SEED_EMAIL_DOMAIN}`],
  );

  const channelIds = [
    ...serverChannels.rows.map((r: { id: string }) => r.id),
    ...dmChannels.rows.map((r: { id: string }) => r.id),
  ];

  if (channelIds.length === 0) return;

  try {
    await connectScylla(config);

    let totalDeleted = 0;
    for (const channelId of channelIds) {
      await scyllaQuery('DELETE FROM messages WHERE channel_id = ?', [channelId]);
      await scyllaQuery('DELETE FROM message_replies WHERE channel_id = ?', [channelId]);
      totalDeleted++;
    }

    if (totalDeleted > 0) {
      logIndent(`scylla messages: cleaned ${totalDeleted} channels`);
    }

    await disconnectScylla();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logWarn(`ScyllaDB cleanup skipped: ${msg}`);
  }
}
