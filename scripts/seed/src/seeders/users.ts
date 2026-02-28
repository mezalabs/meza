import { Code, ConnectError } from '@connectrpc/connect';
import {
  deriveKeys,
  deterministicSalt,
  encryptKeyBundle,
  generateKeyBundle,
  initWasm,
} from '../lib/crypto.ts';
import type { SeedConfig } from '../lib/config.ts';
import { SEED_USERS } from '../lib/ids.ts';
import { log, logError, logIndent, logWarn } from '../lib/log.ts';
import { createAuthClient } from '../lib/rpc.ts';
import { query } from '../lib/db.ts';

export interface SeededUser {
  id: string;
  username: string;
  email: string;
  accessToken: string;
}

/**
 * Register seed users via the Auth service Register RPC.
 * Handles CodeAlreadyExists gracefully by looking up existing users.
 */
export async function seedUsers(config: SeedConfig): Promise<Record<string, SeededUser>> {
  log('Creating users...');

  await initWasm();
  const authClient = createAuthClient(config);
  const result: Record<string, SeededUser> = {};

  for (const [name, userDef] of Object.entries(SEED_USERS)) {
    const salt = await deterministicSalt(userDef.username);
    const { masterKey, authKey } = await deriveKeys(userDef.password, salt);

    const credentialName = `seed:${userDef.username}`;
    const identityBytes = await generateKeyBundle(credentialName);
    const { ciphertext, iv } = await encryptKeyBundle(masterKey, identityBytes);

    try {
      const res = await authClient.register({
        email: userDef.email,
        username: userDef.username,
        authKey,
        salt,
        encryptedKeyBundle: ciphertext,
        keyBundleIv: iv,
      });

      result[name] = {
        id: res.user!.id,
        username: userDef.username,
        email: userDef.email,
        accessToken: res.accessToken,
      };
      logIndent(`${userDef.username} (${userDef.email}) ... created (id: ${res.user!.id})`);
    } catch (err) {
      if (err instanceof ConnectError && err.code === Code.AlreadyExists) {
        // User already exists — look up by email first, then by username
        const existing =
          (await lookupUser('email', userDef.email)) ??
          (await lookupUser('username', userDef.username));
        if (!existing) {
          logError(
            `${userDef.username} reported as existing but not found in DB. ` +
              'Run `task seed:reset` and retry.',
          );
          process.exit(1);
        }
        result[name] = {
          id: existing.id,
          username: userDef.username,
          email: existing.email,
          accessToken: '', // No token for pre-existing users
        };
        logIndent(`${userDef.username} (${existing.email}) ... exists (id: ${existing.id})`);
      } else {
        logError(
          `Auth service Register RPC failed for ${userDef.email}:\n` +
            `  ${err instanceof Error ? err.message : String(err)}`,
        );
        process.exit(1);
      }
    }
  }

  return result;
}

async function lookupUser(
  field: 'email' | 'username',
  value: string,
): Promise<{ id: string; email: string } | null> {
  const res = await query(`SELECT id, email FROM users WHERE ${field} = $1`, [value]);
  return res.rows[0] ?? null;
}
