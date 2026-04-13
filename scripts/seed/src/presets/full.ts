import type { SeedConfig } from '../lib/config.ts';
import {
  S1_CH_GENERAL,
  S1_CH_RANDOM,
  S1_CH_PRIVATE,
  S2_CH_GENERAL,
  S2_CH_ANNOUNCE,
} from '../lib/ids.ts';
import { logBlank } from '../lib/log.ts';
import { seedUsers } from '../seeders/users.ts';
import { seedServers } from '../seeders/servers.ts';
import { seedFriends } from '../seeders/friends.ts';
import { seedChannelKeys } from '../seeders/channel-keys.ts';
import { seedDMs } from '../seeders/dms.ts';
import { getConversations, getDMConversations, seedMessages } from '../seeders/messages.ts';
import { seedExtras } from '../seeders/extras.ts';

/**
 * Full preset: users + servers + friends + DMs + channel keys + messages + extras.
 */
export async function runFull(config: SeedConfig): Promise<void> {
  // 1. Create users with proper key bundles
  const users = await seedUsers(config);
  logBlank();

  // 2. Create servers, channels, roles, members
  await seedServers(users);
  logBlank();

  // 3. Create friend relationships
  await seedFriends(users);
  logBlank();

  // 4. Create DM channels
  const dmChannels = await seedDMs(config, users);
  logBlank();

  // 5. Distribute channel keys for all encrypted channels
  //    (text channels + DMs, not voice/category)
  const channelKeys = await seedChannelKeys(config, [
    // Server 1: Meza Dev
    { channelId: S1_CH_GENERAL, memberNames: ['alice', 'bob', 'charlie'] },
    { channelId: S1_CH_RANDOM, memberNames: ['alice', 'bob', 'charlie'] },
    { channelId: S1_CH_PRIVATE, memberNames: ['alice', 'bob'] },
    // Server 2: Test Server
    { channelId: S2_CH_GENERAL, memberNames: ['alice', 'bob'] },
    { channelId: S2_CH_ANNOUNCE, memberNames: ['alice', 'bob'] },
    // DM channels
    { channelId: dmChannels.aliceBob, memberNames: ['alice', 'bob'] },
    { channelId: dmChannels.aliceCharlie, memberNames: ['alice', 'charlie'] },
  ], users);
  logBlank();

  // 6. Send encrypted messages
  const serverConversations = getConversations({
    s1General: S1_CH_GENERAL,
    s1Random: S1_CH_RANDOM,
    s2General: S2_CH_GENERAL,
  });
  const dmConversationScripts = getDMConversations({
    aliceBob: dmChannels.aliceBob,
    aliceCharlie: dmChannels.aliceCharlie,
  });
  await seedMessages(config, [...serverConversations, ...dmConversationScripts], users, channelKeys);
  logBlank();

  // 7. Create invite + webhook
  await seedExtras(config, users);
}
