import {
  generateChannelKey,
  wrapChannelKey,
  buildKeyWrapAAD,
} from '../lib/crypto.ts';
import type { SeedConfig } from '../lib/config.ts';
import { createKeyClient } from '../lib/rpc.ts';
import { log, logIndent } from '../lib/log.ts';
import type { SeededUser } from './users.ts';

export interface ChannelKeyInfo {
  channelId: string;
  key: Uint8Array;
  version: number;
}

/**
 * Generate per-channel AES-256-GCM keys, ECIES-wrap for each member,
 * and store envelopes via KeyService.StoreKeyEnvelopes.
 *
 * Returns a map of channelId → ChannelKeyInfo for message encryption.
 */
export async function seedChannelKeys(
  config: SeedConfig,
  channels: Array<{ channelId: string; memberNames: string[] }>,
  users: Record<string, SeededUser>,
): Promise<Map<string, ChannelKeyInfo>> {
  log('Distributing channel keys...');

  const keyMap = new Map<string, ChannelKeyInfo>();

  for (const { channelId, memberNames } of channels) {
    const channelKey = generateChannelKey();
    const keyVersion = 1;

    // Wrap the channel key for each member using ECIES
    const envelopes = await Promise.all(
      memberNames.map(async (name) => {
        const user = users[name];
        const aad = buildKeyWrapAAD(channelId, user.identity.publicKey);
        const envelope = await wrapChannelKey(channelKey, user.identity.publicKey, aad);
        return { userId: user.id, envelope };
      }),
    );

    // Store envelopes via KeyService (use alice's token — she's admin on all servers)
    const keyClient = createKeyClient(config, users.alice.accessToken);
    await keyClient.storeKeyEnvelopes({
      channelId,
      keyVersion,
      envelopes,
    });

    keyMap.set(channelId, { channelId, key: channelKey, version: keyVersion });
    logIndent(`${channelId} ... ${memberNames.length} envelopes stored`);
  }

  return keyMap;
}
