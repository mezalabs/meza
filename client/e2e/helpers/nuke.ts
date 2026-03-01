/**
 * Nuke script — wipes all E2E test data from Postgres + Redis.
 *
 * Deletes everything owned by users whose username starts with `e2e_`.
 * Also clears Redis rate-limit keys for test emails.
 * Must be run before each test suite to guarantee a clean slate.
 *
 * Usage: pnpm exec tsx helpers/nuke.ts
 */

import net from 'node:net';
import pg from 'pg';

const DB_CONFIG = {
  host: process.env.MEZA_DB_HOST ?? 'localhost',
  port: Number(process.env.MEZA_DB_PORT ?? 5432),
  database: process.env.MEZA_DB_NAME ?? 'meza',
  user: process.env.MEZA_DB_USER ?? 'meza',
  password: process.env.MEZA_DB_PASSWORD ?? 'meza',
};

async function nuke() {
  const client = new pg.Client(DB_CONFIG);
  await client.connect();

  try {
    // Find test user IDs
    const usersResult = await client.query(
      `SELECT id FROM users WHERE username LIKE 'e2e_%'`,
    );
    const userIds = usersResult.rows.map((r: { id: string }) => r.id);

    if (userIds.length === 0) {
      console.log('No test users found — nothing to nuke.');
      return;
    }

    console.log(`Found ${userIds.length} test user(s). Nuking...`);

    // Find test servers (owned by test users)
    const serversResult = await client.query(
      `SELECT id FROM servers WHERE owner_id = ANY($1)`,
      [userIds],
    );
    const serverIds = serversResult.rows.map((r: { id: string }) => r.id);

    // Find test channels (in test servers)
    let channelIds: string[] = [];
    if (serverIds.length > 0) {
      const channelsResult = await client.query(
        `SELECT id FROM channels WHERE server_id = ANY($1)`,
        [serverIds],
      );
      channelIds = channelsResult.rows.map((r: { id: string }) => r.id);
    }

    // Delete in FK dependency order (leaf → root)
    // Channel-scoped data
    if (channelIds.length > 0) {
      await client.query(
        `DELETE FROM channel_key_envelopes WHERE channel_id = ANY($1)`,
        [channelIds],
      );
      await client.query(
        `DELETE FROM channel_key_versions WHERE channel_id = ANY($1)`,
        [channelIds],
      );
      await client.query(
        `DELETE FROM pinned_messages WHERE channel_id = ANY($1)`,
        [channelIds],
      );
      await client.query(
        `DELETE FROM message_reactions WHERE channel_id = ANY($1)`,
        [channelIds],
      );
      await client.query(
        `DELETE FROM channel_read_states WHERE channel_id = ANY($1)`,
        [channelIds],
      );
      await client.query(
        `DELETE FROM permission_overrides WHERE channel_id = ANY($1)`,
        [channelIds],
      );
      await client.query(
        `DELETE FROM channel_members WHERE channel_id = ANY($1)`,
        [channelIds],
      );
    }

    // Server-scoped data
    if (serverIds.length > 0) {
      await client.query(`DELETE FROM member_roles WHERE server_id = ANY($1)`, [
        serverIds,
      ]);
      await client.query(
        `DELETE FROM soundboard_sounds WHERE server_id = ANY($1)`,
        [serverIds],
      );
      await client.query(
        `DELETE FROM server_emojis WHERE server_id = ANY($1)`,
        [serverIds],
      );
      await client.query(`DELETE FROM audit_log WHERE server_id = ANY($1)`, [
        serverIds,
      ]);
      await client.query(`DELETE FROM bans WHERE server_id = ANY($1)`, [
        serverIds,
      ]);
      await client.query(`DELETE FROM invites WHERE server_id = ANY($1)`, [
        serverIds,
      ]);
      await client.query(`DELETE FROM roles WHERE server_id = ANY($1)`, [
        serverIds,
      ]);
      await client.query(`DELETE FROM channels WHERE server_id = ANY($1)`, [
        serverIds,
      ]);
      await client.query(
        `DELETE FROM channel_groups WHERE server_id = ANY($1)`,
        [serverIds],
      );
      await client.query(`DELETE FROM members WHERE server_id = ANY($1)`, [
        serverIds,
      ]);
      await client.query(`DELETE FROM servers WHERE id = ANY($1)`, [serverIds]);
    }

    // User-scoped data (also catches DM channels where test user is a member)
    await client.query(
      `DELETE FROM channel_read_states WHERE user_id = ANY($1)`,
      [userIds],
    );
    await client.query(`DELETE FROM channel_members WHERE user_id = ANY($1)`, [
      userIds,
    ]);
    await client.query(
      `DELETE FROM notification_preferences WHERE user_id = ANY($1)`,
      [userIds],
    );
    await client.query(`DELETE FROM devices WHERE user_id = ANY($1)`, [
      userIds,
    ]);
    await client.query(
      `DELETE FROM user_blocks WHERE blocker_id = ANY($1) OR blocked_id = ANY($1)`,
      [userIds],
    );
    await client.query(
      `DELETE FROM friendships WHERE requester_id = ANY($1) OR addressee_id = ANY($1)`,
      [userIds],
    );
    await client.query(`DELETE FROM refresh_tokens WHERE user_id = ANY($1)`, [
      userIds,
    ]);
    await client.query(`DELETE FROM user_auth WHERE user_id = ANY($1)`, [
      userIds,
    ]);
    await client.query(`DELETE FROM users WHERE id = ANY($1)`, [userIds]);

    // Clean up DM channels that have no members left (orphaned by user deletion)
    await client.query(`
      DELETE FROM channels WHERE server_id IS NULL
        AND id NOT IN (SELECT DISTINCT channel_id FROM channel_members)
    `);

    // Clear Redis rate-limit keys for test emails
    await nukeRedis();

    console.log(
      `Nuked: ${userIds.length} user(s), ${serverIds.length} server(s), ${channelIds.length} channel(s).`,
    );
  } finally {
    await client.end();
  }
}

/** Send raw Redis commands over TCP to clear rate-limit keys for test emails. */
async function nukeRedis() {
  const url = new URL(process.env.MEZA_REDIS_URL ?? 'redis://localhost:6379');
  const host = url.hostname;
  const port = Number(url.port || 6379);

  const emails = [
    'e2e_alice@test.local',
    'e2e_bob@test.local',
    'e2e_charlie@test.local',
  ];
  const keys = emails.map((e) => `ratelimit:recovery:${e}`);

  return new Promise<void>((resolve) => {
    const sock = net.createConnection({ host, port }, () => {
      // DEL key1 key2 key3
      const args = ['DEL', ...keys];
      const cmd = `*${args.length}\r\n${args.map((a) => `$${Buffer.byteLength(a)}\r\n${a}`).join('\r\n')}\r\n`;
      sock.write(cmd);
    });

    let data = '';
    sock.on('data', (chunk) => {
      data += chunk.toString();
      // Redis responds with ":N\r\n" for DEL
      if (data.includes('\r\n')) {
        sock.end();
      }
    });
    sock.on('end', () => resolve());
    sock.on('error', (err) => {
      console.warn('Redis cleanup skipped:', err.message);
      resolve(); // non-fatal — tests can still run
    });
    sock.setTimeout(3000, () => {
      sock.destroy();
      console.warn('Redis cleanup skipped: timeout');
      resolve();
    });
  });
}

nuke().catch((err) => {
  console.error('Nuke failed:', err);
  process.exit(1);
});
