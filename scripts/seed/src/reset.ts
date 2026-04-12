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

  // ── Collect IDs upfront (before deleting anything) ──
  // These queries depend on users/servers/channels still being in the DB.

  const userRows = await query(
    `SELECT id FROM users WHERE email LIKE $1`,
    [`%${SEED_EMAIL_DOMAIN}`],
  );
  const seedUserIdList = userRows.rows.map((r: { id: string }) => r.id);

  if (seedUserIdList.length === 0) {
    log('No seed users found. Nothing to reset.');
    return;
  }

  const serverRows = await query(
    `SELECT id FROM servers WHERE owner_id = ANY($1)`,
    [seedUserIdList],
  );
  const seedServerIdList = serverRows.rows.map((r: { id: string }) => r.id);

  const serverChannelRows = await query(
    `SELECT id FROM channels WHERE server_id = ANY($1)`,
    [seedServerIdList],
  );
  const serverChannelIdList = serverChannelRows.rows.map((r: { id: string }) => r.id);

  const dmChannelRows = await query(
    `SELECT DISTINCT channel_id AS id FROM channel_members
     WHERE user_id = ANY($1)
       AND channel_id IN (SELECT id FROM channels WHERE type = 3)`,
    [seedUserIdList],
  );
  const dmChannelIdList = dmChannelRows.rows.map((r: { id: string }) => r.id);

  const allChannelIds = [...serverChannelIdList, ...dmChannelIdList];

  // ── Clean ScyllaDB FIRST (while Postgres still has the channel IDs) ──

  if (allChannelIds.length > 0) {
    try {
      await connectScylla(config);
      for (const channelId of allChannelIds) {
        await scyllaQuery('DELETE FROM messages WHERE channel_id = ?', [channelId]);
        await scyllaQuery('DELETE FROM message_replies WHERE channel_id = ?', [channelId]);
      }
      logIndent(`scylla messages: cleaned ${allChannelIds.length} channels`);
      await disconnectScylla();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logWarn(`ScyllaDB cleanup skipped: ${msg}`);
    }
  }

  // ── Delete Postgres rows in dependency order ──

  const steps: Array<[string, string, unknown[]?]> = [
    // Messages and reactions
    ['message_reactions', `DELETE FROM message_reactions WHERE channel_id = ANY($1)`, [allChannelIds]],
    // Channel key envelopes
    ['channel_key_envelopes', `DELETE FROM channel_key_envelopes WHERE channel_id = ANY($1)`, [allChannelIds]],
    ['channel_key_versions', `DELETE FROM channel_key_versions WHERE channel_id = ANY($1)`, [allChannelIds]],
    // Read states
    ['channel_read_states', `DELETE FROM channel_read_states WHERE user_id = ANY($1)`, [seedUserIdList]],
    // Webhooks
    ['webhook_deliveries', `DELETE FROM webhook_deliveries WHERE webhook_id IN (SELECT id FROM webhooks WHERE channel_id = ANY($1))`, [serverChannelIdList]],
    ['webhooks', `DELETE FROM webhooks WHERE channel_id = ANY($1)`, [serverChannelIdList]],
    // Server structure
    ['member_roles', `DELETE FROM member_roles WHERE user_id = ANY($1)`, [seedUserIdList]],
    ['channel_members', `DELETE FROM channel_members WHERE user_id = ANY($1)`, [seedUserIdList]],
    ['pinned_messages', `DELETE FROM pinned_messages WHERE channel_id = ANY($1)`, [allChannelIds]],
    ['roles', `DELETE FROM roles WHERE server_id = ANY($1)`, [seedServerIdList]],
    ['invites', `DELETE FROM invites WHERE server_id = ANY($1)`, [seedServerIdList]],
    // DM channels
    ['dm_channels', `DELETE FROM channels WHERE id = ANY($1)`, [dmChannelIdList]],
    // Server channels
    ['channels', `DELETE FROM channels WHERE server_id = ANY($1)`, [seedServerIdList]],
    ['channel_groups', `DELETE FROM channel_groups WHERE server_id = ANY($1)`, [seedServerIdList]],
    ['members', `DELETE FROM members WHERE server_id = ANY($1)`, [seedServerIdList]],
    ['servers', `DELETE FROM servers WHERE id = ANY($1)`, [seedServerIdList]],
    ['friendships', `DELETE FROM friendships WHERE requester_id = ANY($1) OR addressee_id = ANY($1)`, [seedUserIdList, seedUserIdList]],
    ['devices', `DELETE FROM devices WHERE user_id = ANY($1)`, [seedUserIdList]],
    ['mls_key_packages', `DELETE FROM mls_key_packages WHERE user_id = ANY($1)`, [seedUserIdList]],
    ['user_auth', `DELETE FROM user_auth WHERE user_id = ANY($1)`, [seedUserIdList]],
    ['users', `DELETE FROM users WHERE id = ANY($1)`, [seedUserIdList]],
  ];

  for (const [table, sql, params] of steps) {
    try {
      const res = await query(sql, params);
      if (res.rowCount && res.rowCount > 0) {
        logIndent(`${table}: ${res.rowCount} rows deleted`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('does not exist')) continue;
      throw err;
    }
  }

  log('Seed data reset complete.');
}
