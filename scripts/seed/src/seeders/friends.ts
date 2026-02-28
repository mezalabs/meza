import { query } from '../lib/db.ts';
import { log, logIndent, logWarn } from '../lib/log.ts';
import type { SeededUser } from './users.ts';

/**
 * Seed friend relationships via direct Postgres SQL.
 * Bypasses gateway events (acceptable for dev seed data).
 * Gracefully skips if the friendships table doesn't exist yet.
 */
export async function seedFriends(users: Record<string, SeededUser>): Promise<void> {
  // Check if friendships table exists
  const tableCheck = await query(
    `SELECT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'friendships') AS exists`,
  );
  if (!tableCheck.rows[0].exists) {
    logWarn('friendships table does not exist (migration not run). Skipping friend seeding.');
    return;
  }

  log('Creating friends...');

  // alice <-> bob (accepted)
  await query(
    `INSERT INTO friendships (requester_id, addressee_id, status, created_at, accepted_at)
     VALUES ($1, $2, 'accepted', now(), now())
     ON CONFLICT DO NOTHING`,
    [users.alice.id, users.bob.id],
  );
  logIndent('alice <-> bob (accepted)');

  // alice -> charlie (pending)
  await query(
    `INSERT INTO friendships (requester_id, addressee_id, status, created_at)
     VALUES ($1, $2, 'pending', now())
     ON CONFLICT DO NOTHING`,
    [users.alice.id, users.charlie.id],
  );
  logIndent('alice -> charlie (pending)');
}
