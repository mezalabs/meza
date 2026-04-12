import { Code, ConnectError } from '@connectrpc/connect';
import {
  deriveKeys,
  deterministicSalt,
  aesGcmEncrypt,
  generateIdentityKeypair,
  serializeIdentity,
  generateRecoveryPhrase,
  deriveRecoveryKey,
  deriveRecoveryVerifier,
  encryptRecoveryBundle,
} from '../lib/crypto.ts';
import type { IdentityKeypair } from '@meza/core/crypto/primitives.ts';
import type { SeedConfig } from '../lib/config.ts';
import { SEED_USERS } from '../lib/ids.ts';
import { log, logError, logIndent, logWarn } from '../lib/log.ts';
import { createAuthClient, createKeyClient } from '../lib/rpc.ts';
import { query } from '../lib/db.ts';

export interface SeededUser {
  id: string;
  username: string;
  email: string;
  accessToken: string;
  identity: IdentityKeypair;
}

/**
 * Register seed users via the Auth service Register RPC with full crypto key bundles.
 * After registration, logs in to get a JWT and registers the public key with KeyService.
 * Handles AlreadyExists gracefully by logging in to get a valid token.
 */
export async function seedUsers(config: SeedConfig): Promise<Record<string, SeededUser>> {
  log('Creating users...');

  const authClient = createAuthClient(config);
  const result: Record<string, SeededUser> = {};
  const recoveryPhrases: Array<[string, string]> = [];

  for (const [name, userDef] of Object.entries(SEED_USERS)) {
    const salt = await deterministicSalt(userDef.username);
    const { masterKey, authKey } = await deriveKeys(userDef.password, salt);

    // Generate Ed25519 identity keypair
    const identity = generateIdentityKeypair();
    const serialized = serializeIdentity(identity);

    // Encrypt identity with master key → key bundle
    const { ciphertext: encryptedKeyBundle, iv: keyBundleIv } =
      await aesGcmEncrypt(masterKey, serialized);

    // Generate recovery phrase and encrypt identity with recovery key
    const recoveryPhrase = await generateRecoveryPhrase();
    const recoveryKey = await deriveRecoveryKey(recoveryPhrase);
    const recoveryVerifier = await deriveRecoveryVerifier(recoveryKey);
    const { ciphertext: recoveryEncryptedKeyBundle, iv: recoveryKeyBundleIv } =
      await encryptRecoveryBundle(recoveryKey, serialized);

    let userId: string;
    let accessToken: string;

    try {
      const res = await authClient.register({
        email: userDef.email,
        username: userDef.username,
        authKey,
        salt,
        encryptedKeyBundle,
        keyBundleIv,
        recoveryEncryptedKeyBundle,
        recoveryKeyBundleIv,
        recoveryVerifier,
      });

      userId = res.user!.id;
      accessToken = res.accessToken;
      logIndent(`${userDef.username} (${userDef.email}) ... created (id: ${userId})`);
    } catch (err) {
      if (err instanceof ConnectError && err.code === Code.AlreadyExists) {
        // User already exists — log in to get a valid token
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
        userId = existing.id;

        // Log in to get a valid JWT (we need it for subsequent RPCs)
        const loginRes = await authClient.login({
          identifier: userDef.email,
          authKey,
        });
        accessToken = loginRes.accessToken;
        logIndent(`${userDef.username} (${existing.email}) ... exists (id: ${userId})`);
      } else {
        logError(
          `Auth service Register RPC failed for ${userDef.email}:\n` +
            `  ${err instanceof Error ? err.message : String(err)}`,
        );
        process.exit(1);
      }
    }

    // Register the Ed25519 public key with KeyService
    const keyClient = createKeyClient(config, accessToken);
    await keyClient.registerPublicKey({
      signingPublicKey: identity.publicKey,
    });

    result[name] = { id: userId, username: userDef.username, email: userDef.email, accessToken, identity };
    recoveryPhrases.push([userDef.username, recoveryPhrase]);
  }

  // Log recovery phrases for testing the recovery flow
  log('Recovery phrases:');
  for (const [username, phrase] of recoveryPhrases) {
    logIndent(`${username}: ${phrase}`);
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
