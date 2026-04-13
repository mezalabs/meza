import type { SeedConfig } from '../lib/config.ts';
import { createChatClient } from '../lib/rpc.ts';
import { S1_CH_GENERAL, SERVER1_ID } from '../lib/ids.ts';
import { log, logIndent } from '../lib/log.ts';
import type { SeededUser } from './users.ts';

/**
 * Seed a server invite and a webhook on the "Meza Dev" server.
 */
export async function seedExtras(
  config: SeedConfig,
  users: Record<string, SeededUser>,
): Promise<void> {
  const chatClient = createChatClient(config, users.alice.accessToken);

  // Create a non-expiring invite for "Meza Dev"
  log('Creating invite...');
  const inviteRes = await chatClient.createInvite({
    serverId: SERVER1_ID,
    maxUses: 0,
    maxAgeSeconds: 0,
  });
  logIndent(`Meza Dev invite: ${inviteRes.invite!.code}`);

  // Create a webhook on #general
  log('Creating webhook...');
  const webhookRes = await chatClient.createWebhook({
    channelId: S1_CH_GENERAL,
    name: 'Seed Bot',
  });
  logIndent(`Webhook "Seed Bot" on #general ... created (url: ${webhookRes.url})`);
}
