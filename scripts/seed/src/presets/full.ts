import type { SeedConfig } from '../lib/config.ts';
import { seedFriends } from '../seeders/friends.ts';
import { seedServers } from '../seeders/servers.ts';
import { seedUsers } from '../seeders/users.ts';

/**
 * Full preset: users + 2 servers with channels/roles + friend relationships.
 */
export async function runFull(config: SeedConfig): Promise<void> {
  const users = await seedUsers(config);
  await seedServers(users);
  await seedFriends(users);
}
