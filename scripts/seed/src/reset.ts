import { query } from './lib/db.ts';
import { SEED_EMAIL_DOMAIN } from './lib/ids.ts';
import { log, logIndent } from './lib/log.ts';

/**
 * Delete all seed data in dependency order.
 * Anchored to the @seed.meza.local email domain.
 */
export async function resetSeedData(): Promise<void> {
  log('Resetting seed data...');

  const seedUserIds = `SELECT id FROM users WHERE email LIKE '%${SEED_EMAIL_DOMAIN}'`;
  const seedServerIds = `SELECT id FROM servers WHERE owner_id IN (${seedUserIds})`;

  const steps = [
    ['member_roles', `DELETE FROM member_roles WHERE user_id IN (${seedUserIds})`],
    ['channel_members', `DELETE FROM channel_members WHERE user_id IN (${seedUserIds})`],
    ['pinned_messages', `DELETE FROM pinned_messages WHERE channel_id IN (SELECT id FROM channels WHERE server_id IN (${seedServerIds}))`],
    ['roles', `DELETE FROM roles WHERE server_id IN (${seedServerIds})`],
    ['invites', `DELETE FROM invites WHERE server_id IN (${seedServerIds})`],
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
      // Some tables may not exist (e.g. mls_key_packages) — skip gracefully
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('does not exist')) continue;
      throw err;
    }
  }

  log('Seed data reset complete.');
}
