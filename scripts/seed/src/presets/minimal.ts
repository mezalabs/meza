import type { SeedConfig } from '../lib/config.ts';
import { seedUsers } from '../seeders/users.ts';

/**
 * Minimal preset: 3 seed users only.
 */
export async function runMinimal(config: SeedConfig): Promise<void> {
  await seedUsers(config);
}
