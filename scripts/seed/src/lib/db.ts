import pg from 'pg';
import type { SeedConfig } from './config.ts';

let client: pg.Client | null = null;

export async function connectDb(config: SeedConfig): Promise<pg.Client> {
  if (client) return client;
  client = new pg.Client({ connectionString: config.postgresUrl });
  await client.connect();
  return client;
}

export async function disconnectDb(): Promise<void> {
  if (client) {
    await client.end();
    client = null;
  }
}

export async function query(
  sql: string,
  params?: unknown[],
): Promise<pg.QueryResult> {
  if (!client) throw new Error('Database not connected. Call connectDb() first.');
  return client.query(sql, params);
}
