import cassandra from 'cassandra-driver';
import type { SeedConfig } from './config.ts';

let client: cassandra.Client | null = null;

export async function connectScylla(config: SeedConfig): Promise<cassandra.Client> {
  if (client) return client;
  client = new cassandra.Client({
    contactPoints: [config.scyllaHost],
    localDataCenter: 'datacenter1',
    keyspace: 'meza',
  });
  await client.connect();
  return client;
}

export async function disconnectScylla(): Promise<void> {
  if (client) {
    await client.shutdown();
    client = null;
  }
}

export async function scyllaQuery(
  cql: string,
  params?: unknown[],
): Promise<cassandra.types.ResultSet> {
  if (!client) throw new Error('ScyllaDB not connected. Call connectScylla() first.');
  return client.execute(cql, params, { prepare: true });
}
