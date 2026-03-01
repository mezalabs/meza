import pg from 'pg';
import { expect, test as multiTest } from '../../fixtures/multi-user';

const SEEDED_GROUP_DM_ID = '01TESTE2E0GROUPDM00000000';

// Compose multi-user fixture with a per-test Postgres client.
const test = multiTest.extend<{ db: pg.Client }>({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright fixture convention
  db: async ({}, use) => {
    const client = new pg.Client({
      host: process.env.MEZA_DB_HOST ?? 'localhost',
      port: Number(process.env.MEZA_DB_PORT ?? 5432),
      database: process.env.MEZA_DB_NAME ?? 'meza',
      user: process.env.MEZA_DB_USER ?? 'meza',
      password: process.env.MEZA_DB_PASSWORD ?? 'meza',
    });
    await client.connect();
    await use(client);
    await client.end();
  },
});

/** Look up user IDs from the database by username. */
async function getUserIds(
  db: pg.Client,
  ...usernames: string[]
): Promise<Record<string, string>> {
  const res = await db.query(
    'SELECT id, username FROM users WHERE username = ANY($1)',
    [usernames],
  );
  const map: Record<string, string> = {};
  for (const row of res.rows) {
    map[row.username] = row.id;
  }
  return map;
}

/** Ensure accepted friendships exist between user pairs. */
async function seedFriendships(db: pg.Client, ...pairs: [string, string][]) {
  for (const [a, b] of pairs) {
    await db.query(
      `INSERT INTO friendships (requester_id, addressee_id, status, accepted_at)
       VALUES ($1, $2, 'accepted', now())
       ON CONFLICT (requester_id, addressee_id) DO UPDATE SET status = 'accepted', accepted_at = now()`,
      [a, b],
    );
  }
}

/** Seed a group DM channel (type=4) with given participants. */
async function seedGroupDM(
  db: pg.Client,
  channelId: string,
  creatorId: string,
  participantIds: string[],
  name = 'Group DM',
) {
  // Clean up any prior run
  await db.query('DELETE FROM channel_members WHERE channel_id = $1', [
    channelId,
  ]);
  await db.query('DELETE FROM channels WHERE id = $1', [channelId]);

  await db.query(
    `INSERT INTO channels (id, name, type, is_private, dm_status, dm_initiator_id, created_at, updated_at)
     VALUES ($1, $2, 4, true, 'active', $3, now(), now())`,
    [channelId, name, creatorId],
  );

  for (const userId of participantIds) {
    await db.query(
      'INSERT INTO channel_members (channel_id, user_id, added_at) VALUES ($1, $2, now())',
      [channelId, userId],
    );
  }
}

/** Clean up a group DM channel and its members. */
async function cleanupGroupDM(db: pg.Client, channelId: string) {
  await db.query('DELETE FROM channel_members WHERE channel_id = $1', [
    channelId,
  ]);
  await db.query('DELETE FROM channels WHERE id = $1', [channelId]);
}

/** Clean up friendships between users. */
async function cleanupFriendships(db: pg.Client, ...pairs: [string, string][]) {
  for (const [a, b] of pairs) {
    await db.query(
      'DELETE FROM friendships WHERE (requester_id = $1 AND addressee_id = $2) OR (requester_id = $2 AND addressee_id = $1)',
      [a, b],
    );
  }
}

// ---------------------------------------------------------------------------
// Group Direct Messages
// ---------------------------------------------------------------------------

test.describe('Group direct messages', () => {
  test.describe.configure({ mode: 'serial', timeout: 60_000 });

  test('create a group DM via the dialog', async ({ alicePage, db }) => {
    const users = await getUserIds(db, 'e2e_alice', 'e2e_bob', 'e2e_charlie');

    // Seed friendships so alice can see bob and charlie in the friend picker
    await seedFriendships(
      db,
      [users.e2e_alice, users.e2e_bob],
      [users.e2e_alice, users.e2e_charlie],
    );

    try {
      await alicePage.goto('/');
      await expect(alicePage.getByLabel('Log out')).toBeVisible({
        timeout: 15_000,
      });

      // Navigate to DMs
      await alicePage.getByTitle('Direct Messages').click();
      await expect(alicePage.getByText('Direct Messages')).toBeVisible();

      // Click the "+" button to open CreateGroupDMDialog
      await alicePage.getByTitle('Create Group DM').click();

      // Dialog should be visible
      await expect(alicePage.getByText('Create Group DM').first()).toBeVisible({
        timeout: 10_000,
      });

      // Select bob and charlie from the friend list
      await alicePage.getByText('e2e_bob').click();
      await alicePage.getByText('e2e_charlie').click();

      // Optionally set a group name
      await alicePage.getByPlaceholder('My group chat').fill('Test Group');

      // Create the group DM
      await alicePage.getByRole('button', { name: 'Create' }).click();

      // Dialog should close and the DM pane should open.
      // The group name or participant names should appear in the pane header.
      // Note: encryption may be unavailable in E2E test env, so we check the
      // pane region label rather than the composer placeholder.
      await expect(
        alicePage.locator('main').getByText('Test Group'),
      ).toBeVisible({ timeout: 15_000 });
    } finally {
      // Clean up: remove any group DMs created by alice (type=4)
      await db.query(
        `DELETE FROM channel_members WHERE channel_id IN (
          SELECT id FROM channels WHERE type = 4 AND dm_initiator_id = $1
        )`,
        [users.e2e_alice],
      );
      await db.query(
        'DELETE FROM channels WHERE type = 4 AND dm_initiator_id = $1',
        [users.e2e_alice],
      );
      await cleanupFriendships(
        db,
        [users.e2e_alice, users.e2e_bob],
        [users.e2e_alice, users.e2e_charlie],
      );
    }
  });

  test('group DM appears in sidebar with custom name', async ({
    alicePage,
    bobPage,
    db,
  }) => {
    const users = await getUserIds(db, 'e2e_alice', 'e2e_bob', 'e2e_charlie');
    await seedGroupDM(
      db,
      SEEDED_GROUP_DM_ID,
      users.e2e_alice,
      [users.e2e_alice, users.e2e_bob, users.e2e_charlie],
      'E2E Test Group',
    );

    try {
      // Alice sees the group DM in her sidebar
      await alicePage.goto('/');
      await expect(alicePage.getByLabel('Log out')).toBeVisible({
        timeout: 15_000,
      });
      await alicePage.getByTitle('Direct Messages').click();
      await expect(alicePage.getByText('E2E Test Group')).toBeVisible({
        timeout: 10_000,
      });

      // Bob also sees it
      await bobPage.goto('/');
      await expect(bobPage.getByLabel('Log out')).toBeVisible({
        timeout: 15_000,
      });
      await bobPage.getByTitle('Direct Messages').click();
      await expect(bobPage.getByText('E2E Test Group')).toBeVisible({
        timeout: 10_000,
      });
    } finally {
      await cleanupGroupDM(db, SEEDED_GROUP_DM_ID);
    }
  });

  test('group DM shows participant count badge', async ({ alicePage, db }) => {
    const users = await getUserIds(db, 'e2e_alice', 'e2e_bob', 'e2e_charlie');
    await seedGroupDM(
      db,
      SEEDED_GROUP_DM_ID,
      users.e2e_alice,
      [users.e2e_alice, users.e2e_bob, users.e2e_charlie],
      'E2E Test Group',
    );

    try {
      await alicePage.goto('/');
      await expect(alicePage.getByLabel('Log out')).toBeVisible({
        timeout: 15_000,
      });
      await alicePage.getByTitle('Direct Messages').click();

      // The group DM sidebar item should show participant count "3"
      const groupDMButton = alicePage.getByRole('button', {
        name: /E2E Test Group/,
      });
      await expect(groupDMButton).toBeVisible({ timeout: 10_000 });
      await expect(groupDMButton.getByText('3')).toBeVisible();
    } finally {
      await cleanupGroupDM(db, SEEDED_GROUP_DM_ID);
    }
  });
});
