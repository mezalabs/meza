import type { SeedConfig } from '../lib/config.ts';
import { createChatClient } from '../lib/rpc.ts';
import { log, logIndent } from '../lib/log.ts';
import type { SeededUser } from './users.ts';

export interface SeededDMChannels {
  aliceBob: string;
  aliceCharlie: string;
}

/**
 * Create DM channels between seed users via ChatService.CreateOrGetDMChannel.
 * Returns the channel IDs for key distribution and message seeding.
 */
export async function seedDMs(
  config: SeedConfig,
  users: Record<string, SeededUser>,
): Promise<SeededDMChannels> {
  log('Creating DM channels...');

  // alice -> bob DM
  const aliceChat = createChatClient(config, users.alice.accessToken);
  const aliceBobRes = await aliceChat.createOrGetDMChannel({
    recipientId: users.bob.id,
  });
  logIndent(`alice <-> bob ... ${aliceBobRes.created ? 'created' : 'exists'} (${aliceBobRes.dmChannel!.channel!.id})`);

  // alice -> charlie DM
  const aliceCharlieRes = await aliceChat.createOrGetDMChannel({
    recipientId: users.charlie.id,
  });
  logIndent(`alice <-> charlie ... ${aliceCharlieRes.created ? 'created' : 'exists'} (${aliceCharlieRes.dmChannel!.channel!.id})`);

  const aliceBobId = aliceBobRes.dmChannel!.channel!.id;
  const aliceCharlieId = aliceCharlieRes.dmChannel!.channel!.id;

  return {
    aliceBob: aliceBobId,
    aliceCharlie: aliceCharlieId,
  };
}
