import { loadConfig } from './lib/config.ts';
import { connectDb, disconnectDb } from './lib/db.ts';
import { waitForService } from './lib/health.ts';
import { SEED_EMAIL_DOMAIN } from './lib/ids.ts';
import { log, logBlank, logBox, logError } from './lib/log.ts';
import { query } from './lib/db.ts';
import { runFull } from './presets/full.ts';
import { runMinimal } from './presets/minimal.ts';
import { resetSeedData } from './reset.ts';

const VALID_PRESETS = ['minimal', 'full'] as const;
type Preset = (typeof VALID_PRESETS)[number];

async function main() {
  const args = process.argv.slice(2);
  const isReset = args.includes('--reset');
  const presetArg = args.find((a) => !a.startsWith('-'));
  const preset: Preset = VALID_PRESETS.includes(presetArg as Preset)
    ? (presetArg as Preset)
    : 'full';

  if (presetArg && !VALID_PRESETS.includes(presetArg as Preset)) {
    logError(`Unknown preset: ${presetArg}`);
    log(`Valid presets: ${VALID_PRESETS.join(', ')}`);
    process.exit(1);
  }

  const config = loadConfig();

  log('Checking preconditions...');

  // Wait for Auth service
  process.stdout.write(`\x1b[36m[seed]\x1b[0m Waiting for Auth service on :${config.authPort}... `);
  const healthStart = Date.now();
  await waitForService(config.authPort, 'Auth service');
  console.log(`ready (${((Date.now() - healthStart) / 1000).toFixed(1)}s)`);

  // For full preset, also wait for Chat and Key services
  if (preset === 'full') {
    process.stdout.write(`\x1b[36m[seed]\x1b[0m Waiting for Chat service on :${config.chatPort}... `);
    await waitForService(config.chatPort, 'Chat service');
    console.log('ready');

    process.stdout.write(`\x1b[36m[seed]\x1b[0m Waiting for Key service on :${config.keyPort}... `);
    await waitForService(config.keyPort, 'Key service');
    console.log('ready');
  }

  // Connect to Postgres
  process.stdout.write('\x1b[36m[seed]\x1b[0m Connecting to Postgres... ');
  await connectDb(config);
  console.log('OK');

  try {
    if (isReset) {
      await resetSeedData(config);
      logBlank();
    }

    // Check if already seeded (idempotency)
    if (!isReset) {
      const existing = await query(
        `SELECT COUNT(*)::int as count FROM users WHERE email LIKE $1`,
        [`%${SEED_EMAIL_DOMAIN}`],
      );
      const count = existing.rows[0].count;

      if (preset === 'minimal' && count >= 3) {
        log(`Already seeded (${count} seed users found). Skipping.`);
        return;
      }

      // For 'full' preset, we check if servers exist too
      if (preset === 'full' && count >= 3) {
        const servers = await query(
          `SELECT COUNT(*)::int as count FROM servers WHERE owner_id IN
           (SELECT id FROM users WHERE email LIKE $1)`,
          [`%${SEED_EMAIL_DOMAIN}`],
        );
        if (servers.rows[0].count >= 2) {
          log(`Already seeded (full). Skipping.`);
          return;
        }
        // Users exist but servers don't — run the full preset to complete
      }
    }

    logBlank();
    log(`Running preset: ${preset}`);
    logBlank();

    if (preset === 'minimal') {
      await runMinimal(config);
    } else {
      await runFull(config);
    }

    logBlank();
    log('Done! Seed data ready.');

    logBox([
      'Login credentials (all users):',
      'Password: password123',
      '',
      'alice@seed.meza.local',
      'bob@seed.meza.local',
      'charlie@seed.meza.local',
    ]);
  } finally {
    await disconnectDb();
  }
}

main().catch((err) => {
  logError(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
